/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {
  discoverMod,
  ModFileError,
  readModFile,
  resolveModFile,
} from './mod-discovery.js';
import { capabilityStage, MOD_TARGET } from './mod-contract.js';
import type {
  ModDiagnostic,
  ModRequirement,
  ModValidationReport,
} from './mod-types.js';

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_DIAGNOSTICS = 100;
const BLOCK_SCOPES = new Set([
  'BlockStatement',
  'StaticBlock',
  'CatchClause',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
]);
const RUNTIME_TS_NODES = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
  'TSParameterProperty',
  'TSEnumDeclaration',
  'TSEnumMember',
  'TSModuleDeclaration',
  'TSModuleBlock',
  'TSImportEqualsDeclaration',
  'TSExportAssignment',
]);
const TS_EXPRESSION_WRAPPERS = new Set([
  'TSAsExpression',
  'TSTypeAssertion',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSInstantiationExpression',
]);

type Node = {
  type: string;
  [key: string]: unknown;
  name?: unknown;
  value?: unknown;
  left?: unknown;
  argument?: unknown;
  id?: unknown;
  local?: unknown;
  declaration?: unknown;
  kind?: unknown;
  init?: unknown;
  specifiers?: unknown;
  exported?: unknown;
  source?: unknown;
  computed?: unknown;
  key?: unknown;
  body?: unknown;
  params?: unknown;
  param?: unknown;
  callee?: unknown;
  arguments?: unknown;
  property?: unknown;
  object?: unknown;
  expression?: unknown;
  optional?: unknown;
  shorthand?: unknown;
  importKind?: unknown;
  exportKind?: unknown;
  loc?: { start: { line: number; column: number } };
};
type Scope = {
  parent?: Scope;
  varScope?: boolean;
  bindings: Map<string, 'on' | '$' | 'local'>;
  functions: Map<string, Node>;
};

function node(value: unknown): Node | undefined {
  return value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string'
    ? (value as Node)
    : undefined;
}

function children(value: Node): Node[] {
  return Object.entries(value).flatMap(([key, item]) => {
    if (['loc', 'comments', 'tokens', 'errors'].includes(key)) return [];
    return Array.isArray(item)
      ? item.flatMap((entry) => node(entry) ?? [])
      : (node(item) ?? []);
  });
}

function identifier(value: unknown): string | undefined {
  const item = node(value);
  return item?.type === 'Identifier' && typeof item.name === 'string'
    ? item.name
    : undefined;
}

function runtimeExpression(value: unknown): Node | undefined {
  let expression = node(value);
  while (expression && TS_EXPRESSION_WRAPPERS.has(expression.type)) {
    expression = node(expression.expression);
  }
  return expression;
}

function stringLiteral(value: unknown): string | undefined {
  const item = node(value);
  return item?.type === 'StringLiteral' && typeof item.value === 'string'
    ? item.value
    : undefined;
}

function isFunction(value: Node | undefined): boolean {
  return (
    !!value &&
    [
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
      'ObjectMethod',
      'ClassMethod',
      'ClassPrivateMethod',
    ].includes(value.type)
  );
}

function names(pattern: Node | undefined): string[] {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [String(pattern.name)];
  if (pattern.type === 'AssignmentPattern') return names(node(pattern.left));
  if (pattern.type === 'RestElement') return names(node(pattern.argument));
  if (pattern.type === 'ObjectProperty') return names(node(pattern.value));
  return children(pattern).flatMap((child) => names(child));
}

function bindLocals(value: Node, scope: Scope): void {
  if (
    value.type === 'FunctionDeclaration' ||
    value.type === 'ClassDeclaration'
  ) {
    const name = identifier(value.id);
    if (name) {
      scope.bindings.set(name, 'local');
      if (isFunction(value)) scope.functions.set(name, value);
    }
    return;
  }
  if (isFunction(value) || value.type === 'ClassExpression') return;
  if (value.type === 'VariableDeclarator') {
    for (const name of names(node(value.id))) scope.bindings.set(name, 'local');
    const name = identifier(value.id);
    const init = node(value.init);
    if (name && init && isFunction(init)) scope.functions.set(name, init);
  }
  if (value.type === 'ImportDeclaration') {
    for (const specifier of children(value)) {
      const name = identifier(specifier.local);
      if (name) scope.bindings.set(name, 'local');
    }
  }
  for (const child of children(value)) {
    if (!BLOCK_SCOPES.has(child.type)) bindLocals(child, scope);
  }
}

function bindVars(value: Node, scope: Scope): void {
  if (
    isFunction(value) ||
    ['ClassDeclaration', 'ClassExpression'].includes(value.type)
  )
    return;
  if (value.type === 'VariableDeclaration' && value.kind === 'var') {
    for (const variable of children(value)) {
      for (const name of names(node(variable.id))) {
        scope.bindings.set(name, 'local');
        const init = node(variable.init);
        if (identifier(variable.id) === name && init && isFunction(init)) {
          scope.functions.set(name, init);
        }
      }
    }
  }
  for (const child of children(value)) bindVars(child, scope);
}

function binding(scope: Scope, name: string): 'on' | '$' | 'local' | undefined {
  return (
    scope.bindings.get(name) ??
    (scope.parent ? binding(scope.parent, name) : undefined)
  );
}

function helper(scope: Scope, name: string): Node | undefined {
  if (scope.bindings.has(name)) return scope.functions.get(name);
  return scope.parent ? helper(scope.parent, name) : undefined;
}

function registerFunction(program: Node): Node | undefined {
  const declarations = new Map<string, Node>();
  const exported: string[] = [];
  for (const statement of children(program)) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? node(statement.declaration)
        : statement;
    if (declaration?.type === 'FunctionDeclaration') {
      const name = identifier(declaration.id);
      if (name) declarations.set(name, declaration);
      if (statement.type === 'ExportNamedDeclaration' && name === 'register') {
        exported.push(name);
      }
    }
    if (
      declaration?.type === 'VariableDeclaration' &&
      declaration.kind === 'const'
    ) {
      for (const variable of children(declaration)) {
        const name = identifier(variable.id);
        const init = node(variable.init);
        if (name && init && isFunction(init)) declarations.set(name, init);
        if (
          statement.type === 'ExportNamedDeclaration' &&
          name === 'register'
        ) {
          exported.push(name);
        }
      }
    }
    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of (statement.specifiers as unknown[] | undefined) ??
        []) {
        const item = node(specifier);
        if (
          item &&
          statement.exportKind !== 'type' &&
          item.exportKind !== 'type' &&
          identifier(item.exported) === 'register' &&
          !statement.source
        ) {
          const name = identifier(item.local);
          if (name) exported.push(name);
        }
      }
    }
  }
  return exported.length === 1 ? declarations.get(exported[0]) : undefined;
}

function safeText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? '?' : character;
  }).join('');
}

function position(value: Node): { line?: number; column?: number } {
  return value.loc
    ? { line: value.loc.start.line, column: value.loc.start.column + 1 }
    : {};
}

function literalMatcher(value: Node | undefined): string | undefined {
  if (value?.type !== 'ObjectExpression') return undefined;
  const matcher: Record<string, string | number | boolean> = {};
  for (const property of children(value)) {
    if (property.type !== 'ObjectProperty' || property.computed)
      return undefined;
    const key = identifier(property.key) ?? stringLiteral(property.key);
    const item = node(property.value);
    if (
      !key ||
      !item ||
      !['StringLiteral', 'NumericLiteral', 'BooleanLiteral'].includes(item.type)
    ) {
      return undefined;
    }
    matcher[key] = item.value as string | number | boolean;
  }
  return safeText(JSON.stringify(matcher));
}

export async function validateMods(root: string): Promise<ModValidationReport> {
  const descriptor = await discoverMod(root);
  const diagnostics: ModDiagnostic[] = descriptor.diagnostics.map((item) => ({
    ...item,
    message: safeText(item.message),
    ...(item.file ? { file: safeText(item.file) } : {}),
  }));
  const requirements: ModRequirement[] = [];
  const files: string[] = [];
  let complete = !diagnostics.some((item) =>
    ['MOD_ANALYSIS_LIMIT', 'MOD_ANALYSIS_INCOMPLETE'].includes(item.code),
  );
  let diagnosticLimit = diagnostics.length >= MAX_DIAGNOSTICS;
  let graphLimit = false;
  let totalBytes = 0;
  const visited = new Set<string>();
  const requested = new Set<string>();

  function diagnostic(
    code: string,
    message: string,
    file?: string,
    at?: Node,
    severity: 'error' | 'warning' = 'error',
  ): void {
    if (diagnosticLimit) return;
    if (diagnostics.length >= MAX_DIAGNOSTICS - 1) {
      diagnosticLimit = true;
      complete = false;
      diagnostics.push({
        code: 'MOD_ANALYSIS_LIMIT',
        severity: 'error',
        message: 'The diagnostic limit was reached.',
      });
      return;
    }
    if (
      code === 'MOD_ANALYSIS_INCOMPLETE' ||
      code === 'MOD_ANALYSIS_LIMIT' ||
      code === 'MOD_PATH_CHANGED'
    ) {
      complete = false;
    }
    diagnostics.push({
      code,
      severity,
      message,
      ...(file ? { file: safeText(file) } : {}),
      ...(at ? position(at) : {}),
    });
  }

  function requirement(
    kind: ModRequirement['kind'],
    name: string,
    file: string,
    at: Node,
    extra: Partial<ModRequirement> = {},
  ): void {
    const stage = capabilityStage(kind, name);
    requirements.push({
      kind,
      name: safeText(name),
      stage,
      file: safeText(file),
      ...position(at),
      ...extra,
    });
    if (stage === 'unclassified') {
      diagnostic(
        'MOD_CAPABILITY_UNCLASSIFIED',
        'This literal capability has not been classified in the initial catalog.',
        file,
        at,
        'warning',
      );
    }
  }

  function inspect(program: Node, file: string, register?: Node): void {
    const rootScope: Scope = {
      varScope: true,
      bindings: new Map(),
      functions: new Map(),
    };
    bindLocals(program, rootScope);
    bindVars(program, rootScope);
    const isOnCall = (value: Node | undefined, scope: Scope) => {
      const name =
        value?.type === 'CallExpression' ? identifier(value.callee) : undefined;
      return !!name && binding(scope, name) === 'on';
    };
    function walk(value: Node, current: Scope, parent?: Node): void {
      if (diagnosticLimit) return;
      if (value.type.startsWith('TS') && !RUNTIME_TS_NODES.has(value.type))
        return;
      let scope = current;
      let bodyScope: Scope | undefined;
      if (
        isFunction(value) ||
        BLOCK_SCOPES.has(value.type) ||
        ['ClassExpression', 'ClassDeclaration'].includes(value.type)
      ) {
        scope = {
          parent: current,
          varScope: isFunction(value) || value.type === 'StaticBlock',
          bindings: new Map(),
          functions: new Map(),
        };
        const ownName = identifier(value.id);
        if (ownName) {
          scope.bindings.set(ownName, 'local');
          if (isFunction(value)) scope.functions.set(ownName, value);
        }
        if (BLOCK_SCOPES.has(value.type)) bindLocals(value, scope);
        if (value.type === 'StaticBlock') bindVars(value, scope);
        const params = (value.params as unknown[] | undefined) ?? [];
        const catchMember =
          parent?.type === 'CallExpression' ? node(parent.callee) : undefined;
        const callbackParent =
          isOnCall(parent, current) ||
          (catchMember?.type === 'MemberExpression' &&
            !catchMember.computed &&
            identifier(catchMember.property) === 'catch' &&
            isOnCall(node(catchMember.object), current));
        params.forEach((param, index) => {
          for (const name of names(node(param))) {
            scope.bindings.set(
              name,
              value === register && index === 0
                ? 'on'
                : name === '$' || (callbackParent && index === 0)
                  ? '$'
                  : 'local',
            );
          }
          if (
            (value === register || callbackParent) &&
            index === 0 &&
            !identifier(param)
          ) {
            diagnostic(
              'MOD_ANALYSIS_INCOMPLETE',
              'A host parameter binding cannot be determined statically.',
              file,
              value,
            );
          }
        });
        if (value.type === 'CatchClause') {
          for (const name of names(node(value.param)))
            scope.bindings.set(name, 'local');
        }
        const body = node(value.body);
        if (isFunction(value) && body) {
          bodyScope = {
            parent: scope,
            bindings: new Map(),
            functions: new Map(),
          };
          bindLocals(body, bodyScope);
          bindVars(body, bodyScope);
        }
      }
      if (value.type === 'VariableDeclaration' && value.kind === 'var') {
        let parameters: Scope | undefined = scope;
        while (parameters && !parameters.varScope)
          parameters = parameters.parent;
        for (const variable of children(value)) {
          if (
            names(node(variable.id)).some((name) =>
              ['on', '$'].includes(parameters?.bindings.get(name) ?? ''),
            )
          ) {
            diagnostic(
              'MOD_ANALYSIS_INCOMPLETE',
              'A var declaration can replace a host binding.',
              file,
              value,
            );
          }
        }
      }
      if (
        value.type === 'AssignmentExpression' ||
        value.type === 'UpdateExpression'
      ) {
        const targets = names(
          node(
            value.type === 'AssignmentExpression' ? value.left : value.argument,
          ),
        );
        if (targets.some((target) => helper(scope, target))) {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'A helper binding is reassigned and cannot be proved statically.',
            file,
            value,
          );
        }
      }
      if (value.type === 'ImportExpression') {
        diagnostic(
          'MOD_IMPORT_UNSUPPORTED',
          'Dynamic imports are not supported.',
          file,
          value,
        );
      }
      if (
        value.type === 'TSImportEqualsDeclaration' ||
        value.type === 'TSExportAssignment'
      ) {
        diagnostic(
          'MOD_IMPORT_UNSUPPORTED',
          'CommonJS and TypeScript import-equals forms are not supported.',
          file,
          value,
        );
      }
      if (
        value.type === 'CallExpression' ||
        value.type === 'OptionalCallExpression' ||
        value.type === 'NewExpression'
      ) {
        const callee = node(value.callee);
        const name = identifier(callee);
        if (
          callee?.type === 'Import' ||
          ['require', 'eval', 'Function'].includes(name ?? '')
        ) {
          diagnostic(
            'MOD_IMPORT_UNSUPPORTED',
            'Runtime module loading and generated code are not supported.',
            file,
            value,
          );
        }
        if (name && binding(scope, name) === 'on') {
          const args = (value.arguments as unknown[] | undefined) ?? [];
          const event = stringLiteral(args[0]);
          const matcherNode = node(args[1]);
          const hasMatcher = !!matcherNode && !isFunction(matcherNode);
          const matcher = hasMatcher ? literalMatcher(matcherNode) : undefined;
          const callback = node(args[hasMatcher ? 2 : 1]);
          if (!event || (hasMatcher && matcher === undefined)) {
            diagnostic(
              'MOD_ANALYSIS_INCOMPLETE',
              'An event or matcher cannot be determined statically.',
              file,
              value,
            );
          } else {
            const member =
              parent?.type === 'MemberExpression' ? parent : undefined;
            requirement('event', event, file, value, {
              ...(matcher ? { matcher } : {}),
              hasCatch:
                !!member &&
                !member.computed &&
                identifier(member.property) === 'catch',
            });
          }
          if (!isFunction(callback)) {
            diagnostic(
              'MOD_ANALYSIS_INCOMPLETE',
              'An event callback cannot be determined statically.',
              file,
              value,
            );
          }
          if (
            parent &&
            parent.type !== 'ExpressionStatement' &&
            !(
              parent.type === 'MemberExpression' &&
              !parent.computed &&
              identifier(parent.property) === 'catch' &&
              parent.object === value
            )
          ) {
            diagnostic(
              'MOD_ANALYSIS_INCOMPLETE',
              'An event registration result is used through an unsupported alias or expression.',
              file,
              value,
            );
          }
        }
        if (
          callee?.type === 'MemberExpression' &&
          !callee.computed &&
          identifier(callee.property) === 'catch' &&
          isOnCall(node(callee.object), scope) &&
          !isFunction(node(((value.arguments as unknown[]) ?? [])[0]))
        ) {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'A catch callback cannot be determined statically.',
            file,
            value,
          );
        }
        if (
          callee &&
          ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)
        ) {
          const namespace = node(callee.object);
          const receiver = namespace && identifier(namespace.object);
          if (
            namespace &&
            ['MemberExpression', 'OptionalMemberExpression'].includes(
              namespace.type,
            ) &&
            receiver &&
            binding(scope, receiver) === '$'
          ) {
            const noun = identifier(namespace.property);
            const method = identifier(callee.property);
            if (
              callee.computed ||
              namespace.computed ||
              !noun ||
              !method ||
              callee.optional ||
              namespace.optional
            ) {
              diagnostic(
                'MOD_ANALYSIS_INCOMPLETE',
                'A host method cannot be determined statically.',
                file,
                value,
              );
            } else {
              requirement('api', `${noun}.${method}`, file, value);
            }
          }
        }
      }
      if (value.type === 'JSXOpeningElement') {
        const element = node(value.name);
        if (
          element?.type === 'JSXIdentifier' &&
          typeof element.name === 'string'
        ) {
          requirement('element', element.name, file, element);
        } else {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'A JSX element cannot be determined statically.',
            file,
            value,
          );
        }
      }
      if (
        ['MemberExpression', 'OptionalMemberExpression'].includes(value.type) &&
        identifier(runtimeExpression(value.object)) === 'globalThis' &&
        !binding(scope, 'globalThis')
      ) {
        const property = value.computed
          ? stringLiteral(value.property)
          : identifier(value.property);
        if (['require', 'eval', 'Function'].includes(property ?? '')) {
          diagnostic(
            'MOD_IMPORT_UNSUPPORTED',
            'Runtime loader and generated-code globals are not supported.',
            file,
            value,
          );
        } else if (value.computed && property === undefined) {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'A global property cannot be determined statically.',
            file,
            value,
          );
        }
      }
      if (
        ['MemberExpression', 'OptionalMemberExpression'].includes(value.type) &&
        !(
          parent &&
          ['MemberExpression', 'OptionalMemberExpression'].includes(
            parent.type,
          ) &&
          parent.object === value
        )
      ) {
        if (
          isOnCall(node(value.object), scope) &&
          !(
            value.type === 'MemberExpression' &&
            !value.computed &&
            identifier(value.property) === 'catch' &&
            parent?.type === 'CallExpression' &&
            parent.callee === value
          )
        ) {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'An event registration member cannot be determined statically.',
            file,
            value,
          );
        }
        const parts: Node[] = [];
        let receiver: Node | undefined = value;
        while (
          receiver &&
          ['MemberExpression', 'OptionalMemberExpression'].includes(
            receiver.type,
          )
        ) {
          parts.push(receiver);
          receiver = node(receiver.object);
        }
        const receiverName = identifier(receiver);
        if (
          receiverName &&
          binding(scope, receiverName) === '$' &&
          !(
            parts.length === 2 &&
            parts.every(
              (part) =>
                !part.computed && !part.optional && identifier(part.property),
            ) &&
            parent?.type === 'CallExpression' &&
            parent.callee === value
          )
        ) {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'A host API is referenced through an unsupported alias or expression.',
            file,
            value,
          );
        }
      }
      if (value.type === 'Identifier' && typeof value.name === 'string') {
        const role = binding(scope, value.name);
        const isParameter =
          parent &&
          isFunction(parent) &&
          ((parent.params as unknown[]) ?? []).includes(value);
        const isDirectOnCall =
          parent?.type === 'CallExpression' && parent.callee === value;
        const isMemberReceiver =
          parent?.type === 'MemberExpression' && parent.object === value;
        const helperName =
          parent?.type === 'CallExpression'
            ? identifier(parent.callee)
            : undefined;
        const definition = helperName ? helper(scope, helperName) : undefined;
        const argumentIndex =
          parent?.type === 'CallExpression'
            ? ((parent.arguments as unknown[]) ?? []).indexOf(value)
            : -1;
        const isHelperArgument =
          argumentIndex >= 0 &&
          definition &&
          identifier(
            ((definition.params as unknown[]) ?? [])[argumentIndex],
          ) === '$';
        const isPropertyName =
          !!parent &&
          ((['MemberExpression', 'OptionalMemberExpression'].includes(
            parent.type,
          ) &&
            parent.property === value &&
            !parent.computed) ||
            (['ObjectProperty', 'ObjectMethod', 'ClassMethod'].includes(
              parent.type,
            ) &&
              parent.key === value &&
              !parent.computed &&
              !parent.shorthand));
        if (
          !isPropertyName &&
          !isParameter &&
          ['require', 'eval', 'Function', 'module', 'exports'].includes(
            value.name,
          ) &&
          !binding(scope, value.name)
        ) {
          diagnostic(
            'MOD_IMPORT_UNSUPPORTED',
            'Runtime loader and generated-code bindings are not supported.',
            file,
            value,
          );
        }
        if (
          !isParameter &&
          !isPropertyName &&
          ((role === 'on' && !isDirectOnCall) ||
            (role === '$' && !isMemberReceiver && !isHelperArgument))
        ) {
          diagnostic(
            'MOD_ANALYSIS_INCOMPLETE',
            'A host binding is used through an unsupported alias or expression.',
            file,
            value,
          );
        }
      }
      for (const child of children(value)) {
        const childScope =
          isFunction(value) && value.computed && child === value.key
            ? current
            : child === value.body
              ? (bodyScope ?? scope)
              : scope;
        walk(child, childScope, value);
      }
    }
    walk(program, rootScope);
  }

  async function scan(
    relative: string,
    entry = false,
    declaration = false,
    importer?: string,
  ): Promise<void> {
    if (diagnosticLimit || graphLimit) return;
    const relativeToRoot = path.relative(
      descriptor.root,
      path.resolve(descriptor.root, relative),
    );
    const safeRelative =
      !path.isAbsolute(relative) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(relative) &&
      !relative.includes('\\') &&
      !relativeToRoot.startsWith(`..${path.sep}`) &&
      relativeToRoot !== '..' &&
      !Array.from(relative).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      );
    const diagnosticFile =
      importer ?? (entry && safeRelative ? relative : undefined);
    const normalized = path.posix.normalize(relative);
    const requestKey = `${declaration ? 'types' : 'runtime'}:${normalized}`;
    if (requested.has(requestKey)) return;
    requested.add(requestKey);
    if (
      (declaration && !relative.endsWith('.d.ts')) ||
      (!declaration &&
        (!SOURCE_EXTENSIONS.test(relative) || relative.endsWith('.d.ts')))
    ) {
      diagnostic(
        'MOD_IMPORT_UNSUPPORTED',
        'An explicit supported source filename is required.',
        diagnosticFile,
      );
      return;
    }
    let source: { text: string; realPath: string };
    try {
      const resolved = await resolveModFile(descriptor.root, relative);
      if (!declaration && resolved.realPath.endsWith('.d.ts')) {
        diagnostic(
          'MOD_IMPORT_UNSUPPORTED',
          'A declaration file cannot be used as a runtime module.',
          diagnosticFile,
        );
        return;
      }
      if (visited.has(resolved.realPath)) return;
      if (
        visited.size >= MAX_FILES ||
        BigInt(totalBytes) + resolved.stat.size > BigInt(MAX_TOTAL_BYTES)
      ) {
        graphLimit = true;
        diagnostic(
          'MOD_ANALYSIS_LIMIT',
          'The module graph resource limit was reached.',
          relative,
        );
        return;
      }
      source = await readModFile(descriptor.root, relative, MAX_FILE_BYTES);
    } catch (error) {
      diagnostic(
        error instanceof ModFileError ? error.code : 'MOD_PATH_MISSING',
        'The module could not be safely read.',
        diagnosticFile,
      );
      return;
    }
    if (visited.has(source.realPath)) return;
    relative = path.posix.normalize(relative);
    if (
      visited.size >= MAX_FILES ||
      totalBytes + Buffer.byteLength(source.text) > MAX_TOTAL_BYTES
    ) {
      graphLimit = true;
      diagnostic(
        'MOD_ANALYSIS_LIMIT',
        'The module graph resource limit was reached.',
        relative,
      );
      return;
    }
    visited.add(source.realPath);
    totalBytes += Buffer.byteLength(source.text);
    files.push(safeText(relative));
    let program: Node;
    let parse: typeof import('@babel/parser').parse;
    try {
      const loaded: {
        parse?: typeof import('@babel/parser').parse;
        default?: { parse?: typeof import('@babel/parser').parse };
      } = await import('@babel/parser');
      const parser = loaded.parse ?? loaded.default?.parse;
      if (typeof parser !== 'function') throw new Error('Parser unavailable');
      parse = parser;
    } catch {
      diagnostic(
        'MOD_ANALYSIS_INCOMPLETE',
        'The static parser could not be loaded.',
        relative,
      );
      return;
    }
    try {
      const parsed = parse(source.text, {
        sourceType: 'module',
        createImportExpressions: true,
        plugins: [
          ...(/\.(?:[cm]?ts|tsx)$/.test(relative)
            ? (['typescript'] as const)
            : []),
          ...(/\.[jt]sx$/.test(relative) ? (['jsx'] as const) : []),
        ],
      });
      program = parsed.program as unknown as Node;
    } catch (error) {
      const location =
        typeof error === 'object' && error !== null && 'loc' in error
          ? (error as { loc?: { line: number; column: number } }).loc
          : undefined;
      diagnostic(
        error instanceof RangeError
          ? 'MOD_ANALYSIS_LIMIT'
          : 'MOD_SYNTAX_INVALID',
        error instanceof RangeError
          ? 'The source nesting exceeds parser capacity.'
          : 'The module has invalid syntax.',
        relative,
        location ? { type: 'ParseError', loc: { start: location } } : undefined,
      );
      return;
    }
    const register = entry ? registerFunction(program) : undefined;
    if (entry && !register)
      diagnostic(
        'MOD_ENTRY_EXPORT_INVALID',
        'The entry must export a statically identifiable register function.',
        relative,
      );
    if (!declaration) {
      try {
        inspect(program, relative, register);
      } catch {
        diagnostic(
          'MOD_ANALYSIS_LIMIT',
          'The source nesting exceeds static analysis capacity.',
          relative,
        );
      }
    }
    for (const statement of children(program)) {
      if (
        ![
          'ImportDeclaration',
          'ExportNamedDeclaration',
          'ExportAllDeclaration',
        ].includes(statement.type)
      )
        continue;
      const specifier = stringLiteral(statement.source);
      if (specifier === undefined) continue;
      const typeOnly =
        statement.importKind === 'type' ||
        statement.exportKind === 'type' ||
        (statement.type === 'ImportDeclaration' &&
          (statement.specifiers as Node[]).length > 0 &&
          (statement.specifiers as Node[]).every(
            (item) => item.importKind === 'type',
          ));
      if (typeOnly && specifier === 'claude-code') continue;
      if (declaration && !specifier.startsWith('.')) {
        diagnostic(
          'MOD_TYPE_RESOLUTION_DEFERRED',
          'External declaration dependencies require later resolution.',
          relative,
          statement,
          'warning',
        );
        continue;
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        diagnostic(
          specifier === 'claude-code/state'
            ? 'MOD_DEPENDENCY_DEFERRED'
            : 'MOD_IMPORT_UNSUPPORTED',
          'This runtime import is not supported in the initial slice.',
          relative,
          statement,
        );
        continue;
      }
      // readModFile owns lexical and realpath confinement; do not normalize away traversal here.
      const destination = path.join(path.dirname(relative), specifier);
      await scan(
        destination,
        false,
        declaration || (typeOnly && specifier.endsWith('.d.ts')),
        relative,
      );
    }
  }

  if (descriptor.discovery === 'declared' && descriptor.entry) {
    await scan(descriptor.entry, true);
    const types = descriptor.types;
    if (typeof types === 'string') await scan(types, false, true);
  }
  const locationOrder = (
    a: ModDiagnostic | ModRequirement,
    b: ModDiagnostic | ModRequirement,
  ) =>
    (a.file ?? '').localeCompare(b.file ?? '') ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0);
  diagnostics.sort(
    (a, b) => locationOrder(a, b) || a.code.localeCompare(b.code),
  );
  requirements.sort(
    (a, b) => locationOrder(a, b) || a.name.localeCompare(b.name),
  );
  return {
    schemaVersion: 1,
    target: MOD_TARGET,
    discovery: descriptor.discovery,
    static: {
      status: !complete
        ? 'incomplete'
        : diagnostics.some((item) => item.severity === 'error')
          ? 'invalid'
          : descriptor.discovery === 'absent'
            ? 'not-checked'
            : 'valid',
      complete,
    },
    runtime: 'unavailable',
    ...(descriptor.entry ? { entry: safeText(descriptor.entry) } : {}),
    files: files.sort(),
    requirements,
    diagnostics,
  };
}
