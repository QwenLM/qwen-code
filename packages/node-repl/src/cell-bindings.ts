/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type Parser from 'web-tree-sitter';

type Node = Parser.SyntaxNode;
export interface BindingEdit {
  start: number;
  end: number;
  text: string;
}

const FUNCTIONS = new Set([
  'function_declaration',
  'function_expression',
  'generator_function',
  'generator_function_declaration',
  'arrow_function',
  'method_definition',
]);

function decoded(text: string): string {
  return text.replace(
    /\\u(?:\{([0-9A-Fa-f]+)\}|([0-9A-Fa-f]{4}))/g,
    (_match, braced: string | undefined, fixed: string | undefined) =>
      String.fromCodePoint(Number.parseInt(braced ?? fixed!, 16)),
  );
}

function pattern(node: Node, accept: (node: Node) => void): void {
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      accept(node);
      break;
    case 'assignment_pattern':
    case 'object_assignment_pattern': {
      const left = node.childForFieldName('left');
      if (left) pattern(left, accept);
      break;
    }
    case 'pair_pattern': {
      const value = node.childForFieldName('value');
      if (value) pattern(value, accept);
      break;
    }
    case 'formal_parameters':
    case 'array_pattern':
    case 'object_pattern':
    case 'rest_pattern':
      for (const child of node.namedChildren) pattern(child, accept);
      break;
    default:
      break;
  }
}

function names(node: Node | null): string[] {
  const result: string[] = [];
  if (node) pattern(node, (item) => result.push(decoded(item.text)));
  return result;
}

function unparenthesized(node: Node | null): Node | null {
  while (node?.type === 'parenthesized_expression') {
    node = node.namedChildren.find((child) => child.type !== 'comment') ?? null;
  }
  return node;
}

export function carriedVarEdits(
  root: Node,
  previous: ReadonlySet<string>,
  prefix: string,
): { edits: BindingEdit[]; privateNames: string[] } {
  const edits: BindingEdit[] = [];
  const privateNames: string[] = [];
  const temporary = () => {
    const name = `${prefix}var_${privateNames.length}`;
    privateNames.push(name);
    return name;
  };
  const visit = (node: Node) => {
    if (FUNCTIONS.has(node.type) || node.type === 'class_static_block') return;
    if (
      node.type === 'variable_declarator' &&
      node.parent?.type === 'variable_declaration'
    ) {
      const target = node.childForFieldName('name')!;
      const value = node.childForFieldName('value');
      const declared = names(target);
      if (value && declared.some((name) => previous.has(name))) {
        edits.push({
          start: target.startIndex,
          end: target.endIndex,
          text: `${declared.join(', ')}, ${temporary()}`,
        });
        edits.push({
          start: value.startIndex,
          end: value.startIndex,
          text: `(${target.text} = `,
        });
        edits.push({ start: value.endIndex, end: value.endIndex, text: ')' });
      }
    }
    if (
      node.type === 'for_in_statement' &&
      node.childForFieldName('kind')?.text === 'var'
    ) {
      const target = node.childForFieldName('left')!;
      const declared = names(target);
      if (declared.some((name) => previous.has(name))) {
        const temp = temporary();
        const body = node.childForFieldName('body')!;
        edits.push({
          start: target.startIndex,
          end: target.endIndex,
          text: temp,
        });
        edits.push({
          start: body.startIndex,
          end: body.startIndex,
          text: `{var ${declared.join(', ')}; (${target.text} = ${temp});`,
        });
        edits.push({ start: body.endIndex, end: body.endIndex, text: '}' });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return { edits, privateNames };
}

export function carriedReferenceEdits(
  root: Node,
  previous: ReadonlySet<string>,
  namespace: string,
): BindingEdit[] {
  const declarations = new Set<number>();
  const scopes = new Map<number, Set<string>>();
  const declare = (node: Node | null) => {
    if (node) pattern(node, (item) => declarations.add(item.id));
  };
  const addScope = (node: Node | null, values: Iterable<string>) => {
    if (!node) return;
    const scope = scopes.get(node.id) ?? new Set<string>();
    for (const name of values) scope.add(name);
    scopes.set(node.id, scope);
  };
  const lexicalNames = (node: Node): string[] => {
    if (node.type === 'lexical_declaration') {
      return node.namedChildren.flatMap((child) =>
        names(child.childForFieldName('name')),
      );
    }
    if (
      [
        'function_declaration',
        'generator_function_declaration',
        'class_declaration',
      ].includes(node.type)
    ) {
      return names(node.childForFieldName('name'));
    }
    return [];
  };
  const hoistedNames = (node: Node): string[] => {
    if (FUNCTIONS.has(node.type) || node.type === 'class_static_block')
      return [];
    if (node.type === 'variable_declaration') {
      return node.namedChildren.flatMap((child) =>
        names(child.childForFieldName('name')),
      );
    }
    const own =
      node.type === 'for_in_statement' &&
      node.childForFieldName('kind')?.text === 'var'
        ? names(node.childForFieldName('left'))
        : [];
    return [...own, ...node.namedChildren.flatMap(hoistedNames)];
  };
  const index = (node: Node) => {
    if (node.type === 'variable_declarator')
      declare(node.childForFieldName('name'));
    if (FUNCTIONS.has(node.type)) {
      const parameter =
        node.childForFieldName('parameters') ??
        node.childForFieldName('parameter');
      const body = node.childForFieldName('body');
      const ownName =
        node.type === 'method_definition'
          ? null
          : node.childForFieldName('name');
      declare(ownName);
      declare(parameter);
      const local = [...names(parameter), ...names(ownName)];
      addScope(parameter, local);
      addScope(body, [...local, ...(body ? hoistedNames(body) : [])]);
    }
    if (node.type === 'class_declaration' || node.type === 'class') {
      declare(node.childForFieldName('name'));
      addScope(node, names(node.childForFieldName('name')));
    }
    if (node.type === 'statement_block' || node.type === 'switch_body') {
      const items =
        node.type === 'switch_body'
          ? node.namedChildren.flatMap((child) => child.namedChildren)
          : node.namedChildren;
      addScope(node, items.flatMap(lexicalNames));
    }
    if (node.type === 'class_static_block') {
      for (const child of node.namedChildren)
        addScope(node, hoistedNames(child));
    }
    if (node.type === 'for_statement') {
      const initializer = node.childForFieldName('initializer');
      if (initializer) addScope(node, lexicalNames(initializer));
    }
    if (node.type === 'for_in_statement') {
      const kind = node.childForFieldName('kind');
      const left = node.childForFieldName('left');
      if (kind) declare(left);
      if (kind && kind.text !== 'var') addScope(node, names(left));
    }
    if (node.type === 'catch_clause') {
      const parameter = node.childForFieldName('parameter');
      declare(parameter);
      addScope(node, names(parameter));
    }
    for (const child of node.namedChildren) index(child);
  };
  index(root);
  const edits: BindingEdit[] = [];
  const visit = (node: Node, inherited: ReadonlySet<string>) => {
    if (
      node.type === 'unary_expression' &&
      node.childForFieldName('operator')?.text === 'delete'
    ) {
      const argument = unparenthesized(node.childForFieldName('argument'));
      if (argument?.type === 'identifier')
        throw new SyntaxError(
          'Delete of an unqualified identifier in strict mode.',
        );
    }
    const own = scopes.get(node.id);
    const shadowed = own ? new Set([...inherited, ...own]) : inherited;
    if (
      [
        'identifier',
        'shorthand_property_identifier',
        'shorthand_property_identifier_pattern',
      ].includes(node.type) &&
      !declarations.has(node.id) &&
      node.parent?.type !== 'export_specifier'
    ) {
      const name = decoded(node.text);
      if (previous.has(name) && !shadowed.has(name)) {
        let target = node;
        while (target.parent?.type === 'parenthesized_expression')
          target = target.parent;
        const assignment = target.parent;
        const operator = assignment?.childForFieldName('operator')?.text;
        if (
          assignment &&
          assignment.childForFieldName('left')?.id === target.id &&
          ([
            'assignment_expression',
            'assignment_pattern',
            'object_assignment_pattern',
          ].includes(assignment.type) ||
            (assignment.type === 'augmented_assignment_expression' &&
              ['||=', '&&=', '??='].includes(operator ?? '')))
        ) {
          const right = assignment.childForFieldName('right');
          const definition = unparenthesized(right);
          if (
            right &&
            definition &&
            [
              'arrow_function',
              'function_expression',
              'generator_function',
              'class',
            ].includes(definition.type) &&
            !definition.childForFieldName('name')
          ) {
            edits.push({
              start: right.startIndex,
              end: right.startIndex,
              text: `({[${JSON.stringify(name)}]:`,
            });
            edits.push({
              start: right.endIndex,
              end: right.endIndex,
              text: `})[${JSON.stringify(name)}]`,
            });
          }
        }
        let text = `${namespace}[${JSON.stringify(name)}].value`;
        if (node.type.startsWith('shorthand_'))
          text = `[${JSON.stringify(name)}]: ${text}`;
        let callee = node;
        while (callee.parent?.type === 'parenthesized_expression')
          callee = callee.parent;
        if (
          callee.parent?.type === 'call_expression' &&
          callee.parent.childForFieldName('function')?.id === callee.id
        )
          text = `(0, ${text})`;
        edits.push({ start: node.startIndex, end: node.endIndex, text });
      }
    }
    for (const child of node.namedChildren) visit(child, shadowed);
  };
  visit(root, new Set());
  return edits;
}
