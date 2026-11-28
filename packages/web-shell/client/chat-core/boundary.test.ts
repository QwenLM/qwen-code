/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const CLIENT_ROOT = path.resolve(__dirname, '..');
const CHAT_CORE_DIR = __dirname;
const MANAGED_HOST_ENTRY = path.join(CLIENT_ROOT, 'managed-host.tsx');

const NON_CODE_ASSET_RE =
  /\.(?:css|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot)$/i;

function loadWebShellCompilerOptions(): ts.CompilerOptions {
  const tsconfigPath = path.join(PACKAGE_ROOT, 'tsconfig.json');
  const readResult = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (readResult.error) {
    throw new Error(
      `Failed to read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n')}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    PACKAGE_ROOT,
  );
  return { ...parsed.options, allowJs: true };
}

const COMPILER_OPTIONS = loadWebShellCompilerOptions();

function stripQueryAndHash(specifier: string): string {
  return specifier.split(/[?#]/, 1)[0]!;
}

function isDaemonSpecifier(specifier: string): boolean {
  const clean = stripQueryAndHash(specifier);
  return (
    clean === '@qwen-code/sdk' ||
    clean.startsWith('@qwen-code/sdk/') ||
    clean === '@qwen-code/web-shell' ||
    clean === '@qwen-code/web-shell/daemon-react-sdk' ||
    clean.startsWith('@qwen-code/web-shell/daemon-react-sdk/') ||
    /(?:^|\/)daemon(?:\/|$|\.(?:[cm]?[jt]sx?)$)/.test(clean) ||
    /(?:^|\/)daemon-react-sdk(?:\.(?:[cm]?[jt]sx?))?$/.test(clean)
  );
}

function isDaemonResolvedPath(resolvedPath: string): boolean {
  const candidates = [resolvedPath];
  try {
    const real = fs.realpathSync(resolvedPath);
    if (real !== resolvedPath) candidates.push(real);
  } catch {
    // Non-existent path; inspect resolvedPath directly.
  }
  for (const candidate of candidates) {
    const relToClient = path
      .relative(CLIENT_ROOT, candidate)
      .replace(/\\/g, '/');
    if (
      relToClient === 'daemon.ts' ||
      relToClient === 'daemon.js' ||
      relToClient.startsWith('daemon/') ||
      /^daemon-react-sdk(?:\.(?:[cm]?[jt]sx?|d\.ts))?$/.test(relToClient)
    ) {
      return true;
    }
    const normalized = candidate.replace(/\\/g, '/');
    if (
      normalized.includes('/packages/sdk-typescript/') ||
      normalized.includes('/node_modules/@qwen-code/sdk/')
    ) {
      return true;
    }
  }
  return false;
}

interface ExtractedImport {
  readonly specifier: string;
  readonly isTypeOnly: boolean;
  readonly isUnresolvedDynamic: boolean;
}

function getStaticStringLiteral(
  node: ts.Expression | undefined,
): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function extractModuleSpecifiers(
  fileName: string,
  sourceText: string,
): ExtractedImport[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const found: ExtractedImport[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      let isTypeOnly = false;
      if (clause) {
        if (clause.isTypeOnly) {
          isTypeOnly = true;
        } else if (
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((el) => el.isTypeOnly)
        ) {
          isTypeOnly = true;
        }
      }
      found.push({
        specifier: node.moduleSpecifier.text,
        isTypeOnly,
        isUnresolvedDynamic: false,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let isTypeOnly = node.isTypeOnly;
      if (
        !isTypeOnly &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((el) => el.isTypeOnly)
      ) {
        isTypeOnly = true;
      }
      found.push({
        specifier: node.moduleSpecifier.text,
        isTypeOnly,
        isUnresolvedDynamic: false,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const literal = getStaticStringLiteral(node.arguments[0]);
      if (literal !== null) {
        found.push({
          specifier: literal,
          isTypeOnly: false,
          isUnresolvedDynamic: false,
        });
      } else {
        found.push({
          specifier: '<unresolved-dynamic>',
          isTypeOnly: false,
          isUnresolvedDynamic: true,
        });
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const literal = getStaticStringLiteral(node.arguments[0]);
      if (literal !== null) {
        found.push({
          specifier: literal,
          isTypeOnly: false,
          isUnresolvedDynamic: false,
        });
      } else {
        found.push({
          specifier: '<unresolved-require>',
          isTypeOnly: false,
          isUnresolvedDynamic: true,
        });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const literal = getStaticStringLiteral(node.moduleReference.expression);
      found.push({
        specifier: literal ?? '<unresolved-require>',
        isTypeOnly: node.isTypeOnly,
        isUnresolvedDynamic: literal === null,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      (ts.isStringLiteral(node.argument.literal) ||
        ts.isNoSubstitutionTemplateLiteral(node.argument.literal))
    ) {
      found.push({
        specifier: node.argument.literal.text,
        isTypeOnly: true,
        isUnresolvedDynamic: false,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

function listSourceFilesRecursively(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        /\.(?:[cm]?[jt]sx?)$/.test(entry.name) &&
        !/\.test\.(?:[cm]?[jt]sx?)$/.test(entry.name)
      ) {
        results.push(path.relative(dir, fullPath).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir);
  return results.sort();
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function getPropertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    return getStaticStringLiteral(name.expression);
  }
  return null;
}

function typeNodeReferencesControllerType(
  typeNode: ts.TypeNode | undefined,
): boolean {
  if (!typeNode) return false;
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName;
      if (
        (ts.isIdentifier(name) && name.text === 'SessionChatController') ||
        (ts.isQualifiedName(name) &&
          name.right.text === 'SessionChatController')
      ) {
        found = true;
        return;
      }
    } else if (
      ts.isIndexedAccessTypeNode(node) &&
      ts.isLiteralTypeNode(node.indexType) &&
      ts.isStringLiteral(node.indexType.literal) &&
      node.indexType.literal.text === 'controller'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return found;
}

function isControllerExpression(
  expr: ts.Expression,
  aliases: ReadonlySet<string>,
): boolean {
  const inner = unwrapExpression(expr);
  if (ts.isIdentifier(inner)) {
    return inner.text === 'controller' || aliases.has(inner.text);
  }
  if (ts.isPropertyAccessExpression(inner)) {
    return inner.name.text === 'controller';
  }
  if (ts.isElementAccessExpression(inner)) {
    return getStaticStringLiteral(inner.argumentExpression) === 'controller';
  }
  if (
    ts.isBinaryExpression(inner) &&
    (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      inner.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    return (
      isControllerExpression(inner.left, aliases) ||
      isControllerExpression(inner.right, aliases)
    );
  }
  if (ts.isConditionalExpression(inner)) {
    return (
      isControllerExpression(inner.whenTrue, aliases) ||
      isControllerExpression(inner.whenFalse, aliases)
    );
  }
  if (ts.isObjectLiteralExpression(inner)) {
    return inner.properties.some(
      (prop) =>
        ts.isSpreadAssignment(prop) &&
        isControllerExpression(prop.expression, aliases),
    );
  }
  return false;
}

function findControllerKindAccesses(
  fileName: string,
  sourceText: string,
): number[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const aliases = new Set<string>();
  const lines = new Set<number>();

  const recordLine = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    lines.add(line + 1);
  };

  const inspectObjectBindingForKind = (pattern: ts.ObjectBindingPattern) => {
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) continue;
      const propName = element.propertyName
        ? getPropertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (propName === 'kind') {
        recordLine(element);
      }
    }
  };

  const inspectObjectLiteralForKind = (literal: ts.ObjectLiteralExpression) => {
    for (const prop of literal.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === 'kind') recordLine(prop);
      } else if (ts.isPropertyAssignment(prop)) {
        if (getPropertyNameText(prop.name) === 'kind') recordLine(prop);
      }
    }
  };

  const walkNestedControllerBinding = (
    pattern: ts.BindingName,
    onKindPattern: (p: ts.ObjectBindingPattern) => void,
  ) => {
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) continue;
        const propName = element.propertyName
          ? getPropertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
        if (propName === 'controller') {
          if (ts.isIdentifier(element.name)) {
            aliases.add(element.name.text);
          } else if (ts.isObjectBindingPattern(element.name)) {
            onKindPattern(element.name);
          }
        }
        walkNestedControllerBinding(element.name, onKindPattern);
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isBindingElement(element)) {
          walkNestedControllerBinding(element.name, onKindPattern);
        }
      }
    }
  };

  const unwrapAssignmentTarget = (expr: ts.Expression): ts.Expression => {
    const inner = unwrapExpression(expr);
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return unwrapExpression(inner.left);
    }
    return inner;
  };

  const walkNestedControllerAssignment = (
    target: ts.ObjectLiteralExpression,
    onKindLiteral: (literal: ts.ObjectLiteralExpression) => void,
  ) => {
    for (const prop of target.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const propName = getPropertyNameText(prop.name);
        const nestedTarget = unwrapAssignmentTarget(prop.initializer);
        if (propName === 'controller') {
          if (ts.isIdentifier(nestedTarget)) {
            aliases.add(nestedTarget.text);
          } else if (ts.isObjectLiteralExpression(nestedTarget)) {
            onKindLiteral(nestedTarget);
          }
        } else if (ts.isObjectLiteralExpression(nestedTarget)) {
          walkNestedControllerAssignment(nestedTarget, onKindLiteral);
        }
      }
    }
  };

  let prevAliasCount = -1;
  while (aliases.size !== prevAliasCount) {
    prevAliasCount = aliases.size;
    const collectAliases = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node)) {
        const isTypedController = typeNodeReferencesControllerType(node.type);
        const isInitController =
          node.initializer !== undefined &&
          isControllerExpression(node.initializer, aliases);
        if (isTypedController || isInitController) {
          if (ts.isIdentifier(node.name)) {
            aliases.add(node.name.text);
          }
        }
        walkNestedControllerBinding(node.name, () => {});
      } else if (ts.isParameter(node)) {
        const isControllerParam =
          typeNodeReferencesControllerType(node.type) ||
          (node.initializer !== undefined &&
            isControllerExpression(node.initializer, aliases));
        if (isControllerParam && ts.isIdentifier(node.name)) {
          aliases.add(node.name.text);
        }
        walkNestedControllerBinding(node.name, () => {});
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrapExpression(node.left);
        if (
          ts.isIdentifier(left) &&
          isControllerExpression(node.right, aliases)
        ) {
          aliases.add(left.text);
        } else if (ts.isObjectLiteralExpression(left)) {
          walkNestedControllerAssignment(left, () => {});
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sf);
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'kind' &&
      isControllerExpression(node.expression, aliases)
    ) {
      recordLine(node);
    } else if (
      ts.isElementAccessExpression(node) &&
      getStaticStringLiteral(node.argumentExpression) === 'kind' &&
      isControllerExpression(node.expression, aliases)
    ) {
      recordLine(node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      node.expression.name.text === 'get' &&
      node.arguments.length >= 2 &&
      isControllerExpression(node.arguments[0]!, aliases) &&
      getStaticStringLiteral(node.arguments[1]) === 'kind'
    ) {
      recordLine(node);
    } else if (ts.isVariableDeclaration(node)) {
      const isControllerBinding =
        typeNodeReferencesControllerType(node.type) ||
        (node.initializer !== undefined &&
          isControllerExpression(node.initializer, aliases));
      if (isControllerBinding && ts.isObjectBindingPattern(node.name)) {
        inspectObjectBindingForKind(node.name);
      }
      walkNestedControllerBinding(node.name, inspectObjectBindingForKind);
    } else if (ts.isParameter(node)) {
      const isControllerParam =
        typeNodeReferencesControllerType(node.type) ||
        (node.initializer !== undefined &&
          isControllerExpression(node.initializer, aliases));
      if (isControllerParam && ts.isObjectBindingPattern(node.name)) {
        inspectObjectBindingForKind(node.name);
      }
      walkNestedControllerBinding(node.name, inspectObjectBindingForKind);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.left);
      if (ts.isObjectLiteralExpression(left)) {
        if (isControllerExpression(node.right, aliases)) {
          inspectObjectLiteralForKind(left);
        }
        walkNestedControllerAssignment(left, inspectObjectLiteralForKind);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return [...lines].sort((a, b) => a - b);
}

function findChatCoreDaemonViolations(rootDir: string): {
  files: string[];
  violations: string[];
} {
  const files = listSourceFilesRecursively(rootDir);
  const violations: string[] = [];
  for (const file of files) {
    const fullPath = path.join(rootDir, file);
    const sourceText = fs.readFileSync(fullPath, 'utf8');
    for (const { specifier, isUnresolvedDynamic } of extractModuleSpecifiers(
      fullPath,
      sourceText,
    )) {
      if (isUnresolvedDynamic || isDaemonSpecifier(specifier)) {
        violations.push(`${file} => ${specifier}`);
        continue;
      }
      const clean = stripQueryAndHash(specifier);
      if (NON_CODE_ASSET_RE.test(clean)) continue;
      const resolution = ts.resolveModuleName(
        clean,
        fullPath,
        COMPILER_OPTIONS,
        ts.sys,
      ).resolvedModule;
      if (!resolution) {
        violations.push(`${file} => <unresolved:${specifier}>`);
        continue;
      }
      if (isDaemonResolvedPath(path.resolve(resolution.resolvedFileName))) {
        violations.push(`${file} => ${specifier}`);
      }
    }
  }
  return { files, violations };
}

function findChatCoreControllerKindViolations(rootDir: string): string[] {
  const files = listSourceFilesRecursively(rootDir);
  const violations: string[] = [];
  for (const file of files) {
    const fullPath = path.join(rootDir, file);
    const sourceText = fs.readFileSync(fullPath, 'utf8');
    const lines = findControllerKindAccesses(fullPath, sourceText);
    for (const line of lines) {
      violations.push(`${file}:${line}`);
    }
  }
  return violations;
}

interface ManagedHostGraphResult {
  readonly daemonEdges: string[];
  readonly unresolvedSpecifiers: string[];
  readonly visitedFiles: string[];
}

function collectManagedHostGraph(
  entryFile: string,
  baseDir: string = CLIENT_ROOT,
): ManagedHostGraphResult {
  const resolvedEntry = path.resolve(entryFile);
  const visited = new Set<string>([resolvedEntry]);
  const queue = [resolvedEntry];
  const daemonEdges = new Set<string>();
  const unresolvedSpecifiers = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const relCurrent = path.relative(baseDir, current).replace(/\\/g, '/');
    const sourceText = fs.readFileSync(current, 'utf8');

    for (const {
      specifier,
      isTypeOnly,
      isUnresolvedDynamic,
    } of extractModuleSpecifiers(current, sourceText)) {
      if (isTypeOnly) continue;
      if (isUnresolvedDynamic) {
        unresolvedSpecifiers.add(`${relCurrent} => ${specifier}`);
        continue;
      }
      if (isDaemonSpecifier(specifier)) {
        daemonEdges.add(`${relCurrent} => ${specifier}`);
        continue;
      }

      const clean = stripQueryAndHash(specifier);
      if (NON_CODE_ASSET_RE.test(clean)) {
        continue;
      }

      const resolution = ts.resolveModuleName(
        clean,
        current,
        COMPILER_OPTIONS,
        ts.sys,
      ).resolvedModule;

      if (!resolution) {
        unresolvedSpecifiers.add(`${relCurrent} => ${specifier}`);
        continue;
      }

      const resolvedPath = path.resolve(resolution.resolvedFileName);
      if (isDaemonResolvedPath(resolvedPath)) {
        daemonEdges.add(`${relCurrent} => ${specifier}`);
        continue;
      }

      const isLocalSource =
        !resolution.isExternalLibraryImport &&
        !resolvedPath.endsWith('.d.ts') &&
        !resolvedPath.includes(`${path.sep}node_modules${path.sep}`) &&
        (resolvedPath.startsWith(`${PACKAGE_ROOT}${path.sep}`) ||
          resolvedPath.startsWith(`${path.resolve(baseDir)}${path.sep}`));

      if (isLocalSource) {
        if (!visited.has(resolvedPath)) {
          visited.add(resolvedPath);
          queue.push(resolvedPath);
        }
        continue;
      }

      if (
        clean.startsWith('.') ||
        clean.startsWith('@/') ||
        clean.startsWith('@qwen-code/web-shell/')
      ) {
        unresolvedSpecifiers.add(`${relCurrent} => ${specifier}`);
      }
    }
  }

  return {
    daemonEdges: [...daemonEdges].sort(),
    unresolvedSpecifiers: [...unresolvedSpecifiers].sort(),
    visitedFiles: [...visited]
      .map((f) => path.relative(baseDir, f).replace(/\\/g, '/'))
      .sort(),
  };
}

describe('chat-core and managed-host boundary guards', () => {
  it('enforces zero daemon imports (value or type, static or dynamic) recursively across chat-core/**', () => {
    const { files, violations } = findChatCoreDaemonViolations(CHAT_CORE_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => /\.test\.(?:[cm]?[jt]sx?)$/.test(f))).toBe(false);
    expect(violations).toEqual([]);
  });

  it('enforces zero controller.kind reads across chat-core/**', () => {
    expect(findChatCoreControllerKindViolations(CHAT_CORE_DIR)).toEqual([]);
  });

  it('enforces zero transitive daemon value-import edges and zero unresolved imports from managed-host.tsx', () => {
    const { daemonEdges, unresolvedSpecifiers, visitedFiles } =
      collectManagedHostGraph(MANAGED_HOST_ENTRY);
    expect(visitedFiles).toEqual(
      expect.arrayContaining([
        'ManagedAgentWebShell.tsx',
        'components/managed/ManagedSessionsPage.tsx',
        'chat-core/ChatSurface.tsx',
        'components/ChatEditor.tsx',
        'components/TranscriptViewport.tsx',
        'components/messages/SystemMessage.tsx',
        'components/artifacts/TurnOutputs.tsx',
      ]),
    );
    expect(unresolvedSpecifiers).toEqual([]);
    expect(daemonEdges).toEqual([]);
  });

  it('catches nested chat-core daemon imports, @qwen-code/sdk root, inline import() types, and computed dynamic imports', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-core-guard-'));
    try {
      const nestedDir = path.join(tempDir, 'messages');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(
        path.join(nestedDir, 'StatusRegion.tsx'),
        [
          `import type { DaemonHttpError } from '@qwen-code/sdk/daemon';`,
          `import { DaemonClient } from '@qwen-code/sdk';`,
          `type Inline = import('@qwen-code/sdk/daemon').DaemonEvent;`,
          `const dynamicLoad = (p: string) => import(p);`,
          `const templatedLoad = (name: string) => import(\`../../daemon/\${name}.js\`);`,
          `const cjsLoad = (p: string) => require(p);`,
          `import type { Hidden } from '@unmodeled/alias';`,
          `export { dynamicLoad, templatedLoad, cjsLoad, type DaemonHttpError, type Inline, type Hidden, DaemonClient };`,
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(nestedDir, 'StatusRegion.test.tsx'),
        `import { DaemonHttpError } from '@qwen-code/sdk/daemon';\nexport { DaemonHttpError };\n`,
      );

      const { files, violations } = findChatCoreDaemonViolations(tempDir);
      expect(files).toEqual(['messages/StatusRegion.tsx']);
      expect(violations).toEqual([
        'messages/StatusRegion.tsx => @qwen-code/sdk/daemon',
        'messages/StatusRegion.tsx => @qwen-code/sdk',
        'messages/StatusRegion.tsx => @qwen-code/sdk/daemon',
        'messages/StatusRegion.tsx => <unresolved-dynamic>',
        'messages/StatusRegion.tsx => <unresolved-dynamic>',
        'messages/StatusRegion.tsx => <unresolved-require>',
        'messages/StatusRegion.tsx => <unresolved:@unmodeled/alias>',
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('catches all controller.kind spellings while ignoring comments, type declarations, and operation.kind', () => {
    const source = [
      `// controller.kind in comment is ignored`,
      `interface SessionChatController { readonly kind: 'daemon' | 'managed'; }`,
      `const opKind = operation.kind === 'cancel';`,
      `const a = controller.kind;`,
      `const b = props.controller?.kind;`,
      `const c = controller['kind'];`,
      `const { kind } = controller;`,
      `const { kind: k2 } = props.controller;`,
      `function Surface({ controller: { kind: k3 } }: { controller: SessionChatController }) { return k3; }`,
      `function readTyped({ kind: k4 }: SessionChatController) { return k4; }`,
      `function readTypedParam(c: SessionChatController) { return c.kind; }`,
      `function readIndexedParam(c: ChatSurfaceProps['controller']) { return c.kind; }`,
      `function readDefaultParam({ kind: k8 } = controller) { return k8; }`,
      `const alias = controller; const d = alias.kind;`,
      `const { controller: renamed } = props; const { kind: k5 } = renamed;`,
      `const fallback = (props.controller ?? other).kind;`,
      `let k6; ({ kind: k6 } = controller);`,
      `let k7; ({ controller: { kind: k7 } = fallbackCtrl } = props);`,
      `const e = Reflect.get(controller, 'kind');`,
    ].join('\n');

    expect(findControllerKindAccesses('synthetic.tsx', source)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  it('resolves tsconfig path aliases such as @qwen-code/web-shell/transcript into its subtree and fails closed on unmodeled aliases or computed imports', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'managed-host-graph-'),
    );
    try {
      const entryPath = path.join(tempDir, 'entry.ts');
      fs.writeFileSync(
        entryPath,
        [
          `import { WebShellTranscript } from '@qwen-code/web-shell/transcript';`,
          `import { something } from '@unmodeled/alias';`,
          `import { DaemonHttpError } from '@qwen-code/sdk';`,
          `import type { DaemonClient } from '@qwen-code/sdk';`,
          `const dynamicLoad = (p: string) => import(p);`,
          `export { WebShellTranscript, something, DaemonHttpError, dynamicLoad, type DaemonClient };`,
        ].join('\n'),
      );

      const result = collectManagedHostGraph(entryPath, tempDir);
      expect(result.daemonEdges).toContain('entry.ts => @qwen-code/sdk');
      expect(
        result.visitedFiles.some((file) => file.endsWith('transcript.ts')),
      ).toBe(true);
      expect(
        result.daemonEdges.some((edge) =>
          edge.endsWith(
            'McpStatusMessage.tsx => @qwen-code/web-shell/daemon-react-sdk',
          ),
        ),
      ).toBe(true);
      expect(result.unresolvedSpecifiers).toEqual([
        'entry.ts => <unresolved-dynamic>',
        'entry.ts => @unmodeled/alias',
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
