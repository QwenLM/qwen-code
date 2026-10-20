/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import ts from 'typescript';
import { readModFile } from './discovery.js';
import { MOD_MAX_BYTES, type ModSource } from './types.js';

const suffixes = ['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts'];
const maxGraphBytes = 1024 * 1024;

async function resolveImport(
  root: string,
  importer: string,
  specifier: string,
) {
  if (!/^(?:\.{1,2}\/|\.{1,2}$)/.test(specifier) || specifier.includes('\\')) {
    throw new Error(
      'Mod imports must be relative static JavaScript or TypeScript imports.',
    );
  }
  const target = path.resolve(
    path.dirname(importer),
    specifier,
    /^\.{1,2}\/?$/.test(specifier) ? 'index' : '',
  );
  const extension = path.extname(target);
  if (extension && !suffixes.includes(extension)) {
    throw new Error('Unsupported Mod import extension.');
  }
  const replacements: Record<string, string> = {
    '.js': '.ts',
    '.mjs': '.mts',
    '.cjs': '.cts',
  };
  const candidates = [target];
  if (replacements[extension])
    candidates.push(
      target.slice(0, -extension.length) + replacements[extension],
    );
  for (const suffix of suffixes)
    candidates.push(target + suffix, path.join(target, 'index' + suffix));
  for (const candidate of candidates) {
    try {
      const file = await readModFile(root, candidate);
      if (!suffixes.includes(path.extname(candidate)))
        throw new Error('Unsupported Mod import extension.');
      return file;
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'EISDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  throw new Error(`Mod import not found: ${specifier}.`);
}

export async function compileModModules(input: ModSource) {
  const modules = new Map<string, string>();
  const imports = new Map<string, Map<string, string>>();
  let inputBytes = 0;
  let outputBytes = 0;
  async function visit(entry: string, source: string): Promise<void> {
    if (modules.has(entry)) return;
    const bytes = Buffer.byteLength(source);
    inputBytes += bytes;
    if (
      bytes > MOD_MAX_BYTES ||
      inputBytes > maxGraphBytes ||
      modules.size >= 64
    ) {
      throw new Error('Mod source graph exceeds its file or byte limit.');
    }
    const isTypescript = /\.[cm]?ts$/.test(entry);
    const syntax = ts.createSourceFile(
      isTypescript ? 'mod.ts' : 'mod.js',
      source,
      ts.ScriptTarget.ES2022,
      true,
      isTypescript ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    function check(node: ts.Node, inFunction = false): void {
      if (
        (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) ||
        (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === 'require')))
      ) {
        throw new Error(
          'Dynamic import and require are not supported in Mods.',
        );
      }
      if (
        entry !== input.entry &&
        !inFunction &&
        (ts.isAwaitExpression(node) ||
          (ts.isForOfStatement(node) && node.awaitModifier))
      ) {
        throw new Error(
          'Top-level await in imported Mod modules is not supported.',
        );
      }
      ts.forEachChild(node, (child) => {
        const functionBody =
          ts.isFunctionLike(node) &&
          (ts.isParameter(child) || ('body' in node && node.body === child));
        check(child, inFunction || functionBody);
      });
    }
    check(syntax);
    let output = source;
    if (isTypescript) {
      const compiled = ts.transpileModule(source, {
        fileName: 'mod.ts',
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
        },
        reportDiagnostics: true,
      });
      if (
        compiled.diagnostics?.some(
          (item) => item.category === ts.DiagnosticCategory.Error,
        )
      ) {
        throw new Error(`Invalid Mod TypeScript: ${path.basename(entry)}.`);
      }
      output = compiled.outputText;
    }
    outputBytes += Buffer.byteLength(output);
    if (outputBytes > maxGraphBytes)
      throw new Error('Compiled Mod graph exceeds the 1 MiB limit.');
    modules.set(entry, output);
    const edges = new Map<string, string>();
    imports.set(entry, edges);
    const emitted = ts.createSourceFile(
      'mod.js',
      output,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    check(emitted);
    for (const statement of emitted.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier) continue;
      if (!ts.isStringLiteral(specifier))
        throw new Error('Invalid Mod static import.');
      const resolved = await resolveImport(input.root, entry, specifier.text);
      edges.set(specifier.text, resolved.entry);
      await visit(resolved.entry, resolved.source);
    }
  }
  await visit(input.entry, input.source);
  return { modules, imports };
}
