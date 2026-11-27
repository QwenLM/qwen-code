/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = path.resolve(__dirname, '..');
const CHAT_CORE_DIR = __dirname;
const MANAGED_HOST_ENTRY = path.join(CLIENT_ROOT, 'managed-host.tsx');

function isDaemonSpecifier(specifier: string): boolean {
  return (
    specifier === '@qwen-code/sdk/daemon' ||
    specifier === '@qwen-code/web-shell/daemon-react-sdk' ||
    /(?:^|\/)daemon(?:\/|$)/.test(specifier) ||
    /(?:^|\/)daemon-react-sdk(?:\.(?:ts|tsx|js|jsx))?$/.test(specifier)
  );
}

interface ExtractedImport {
  readonly specifier: string;
  readonly isTypeOnly: boolean;
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
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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
      found.push({ specifier: node.moduleSpecifier.text, isTypeOnly });
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
      found.push({ specifier: node.moduleSpecifier.text, isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      found.push({ specifier: node.arguments[0]!.text, isTypeOnly: false });
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
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
    ts.ScriptKind.TSX,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'kind' &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'controller'
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      lines.push(line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function resolveLocalModule(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? path.resolve(CLIENT_ROOT, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  const stripped = base.replace(/\.(js|jsx|ts|tsx)$/, '');
  for (const candidate of [
    base,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.js`,
    `${stripped}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectManagedHostDaemonValueEdges(entryFile: string): string[] {
  const visited = new Set<string>([entryFile]);
  const queue = [entryFile];
  const edges = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const relCurrent = path.relative(CLIENT_ROOT, current).replace(/\\/g, '/');
    const sourceText = fs.readFileSync(current, 'utf8');
    for (const { specifier, isTypeOnly } of extractModuleSpecifiers(
      current,
      sourceText,
    )) {
      if (isTypeOnly) continue;
      if (isDaemonSpecifier(specifier)) {
        edges.add(`${relCurrent} => ${specifier}`);
        continue;
      }
      const next = resolveLocalModule(current, specifier);
      if (next && !visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }

  return [...edges].sort();
}

/**
 * Remaining transitive daemon value-import edges reachable from
 * `client/managed-host.tsx` (burned down from 47 to 31 in Slice 6a).
 *
 * Slices 6b (`ChatEditor` toolbar/upload decoupling) and 6c
 * (`TranscriptViewport` / `TurnOutputs` / `ToolApproval` / `SystemMessage`
 * decoupling + `dist-managed-host/index.js` CI grep gate) will empty this list.
 * Never add entries; remove entries as each slice lands.
 */
const REMAINING_MANAGED_HOST_DAEMON_EDGES: readonly string[] = [
  // Slice 6b: ChatEditor daemon-only toolbar/upload controls (15 edges)
  'components/BranchPickerPopover.tsx => @qwen-code/sdk/daemon',
  'components/BranchPickerPopover.tsx => @qwen-code/web-shell/daemon-react-sdk',
  'hooks/useFileUpload.ts => ../daemon/availability-context.js',
  'hooks/useFileUpload.ts => ../daemon/availability.js',
  'live/useLiveBrowserHost.ts => ../daemon/availability-context.js',
  'live/useLiveVoice.ts => ../daemon/availability-context.js',
  'live/useLiveVoice.ts => ../daemon/availability.js',
  'live/useLiveVoice.ts => @qwen-code/web-shell/daemon-react-sdk',
  'session-catalog/session-catalog-hooks.ts => ../daemon/availability-context.js',
  'session-catalog/session-catalog-hooks.ts => ../daemon/availability.js',
  'session-catalog/session-catalog-hooks.ts => @qwen-code/web-shell/daemon-react-sdk',
  'session-catalog/session-catalog-store.ts => ../daemon/availability.js',
  'voice/VoiceButton.tsx => @qwen-code/web-shell/daemon-react-sdk',
  'voice/useVoiceCapture.ts => ../daemon/availability-context.js',
  'voice/useVoiceCapture.ts => ../daemon/availability.js',
  // Slice 6c: TranscriptViewport / TurnOutputs / ToolApproval / SystemMessage (16 edges)
  'adapters/transcriptToMessages.ts => @qwen-code/sdk/daemon',
  'browser-turn-notifications.tsx => ./daemon/session/turn-notification-context',
  'components/TranscriptViewport.tsx => ../daemon/session/DaemonSessionProvider',
  'components/artifacts/artifactUtils.ts => @qwen-code/sdk/daemon',
  'components/artifacts/useArtifactWorkspaceTarget.ts => @qwen-code/web-shell/daemon-react-sdk',
  'components/messages/GoalStatusMessage.tsx => @qwen-code/sdk/daemon',
  'components/messages/HookStatistics.tsx => @qwen-code/sdk/daemon',
  'components/messages/McpStatusMessage.tsx => @qwen-code/web-shell/daemon-react-sdk',
  'components/messages/SystemMessage.tsx => @qwen-code/sdk/daemon',
  'components/messages/TasksStatusMessage.tsx => ../../daemon/availability-context.js',
  'components/messages/TasksStatusMessage.tsx => ../../daemon/availability.js',
  'components/messages/TasksStatusMessage.tsx => @qwen-code/web-shell/daemon-react-sdk',
  'components/messages/ToolFilePreviewButton.tsx => @qwen-code/web-shell/daemon-react-sdk',
  'hooks/useMessageDeletion.ts => @qwen-code/sdk/daemon',
  'hooks/useMessageDeletion.ts => @qwen-code/web-shell/daemon-react-sdk',
  'hooks/useTranscriptViewport.ts => ../daemon/session/DaemonSessionProvider',
].sort();

describe('chat-core and managed-host boundary guards (slice 6a)', () => {
  it('enforces zero daemon imports (value or type) across all chat-core source files', () => {
    const files = fs
      .readdirSync(CHAT_CORE_DIR)
      .filter(
        (name) =>
          /\.(?:ts|tsx)$/.test(name) && !/\.test\.(?:ts|tsx)$/.test(name),
      )
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const fullPath = path.join(CHAT_CORE_DIR, file);
      const sourceText = fs.readFileSync(fullPath, 'utf8');
      for (const { specifier } of extractModuleSpecifiers(
        fullPath,
        sourceText,
      )) {
        if (isDaemonSpecifier(specifier)) {
          violations.push(`${file} => ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('enforces zero controller.kind branches in ChatSurface.tsx', () => {
    const surfacePath = path.join(CHAT_CORE_DIR, 'ChatSurface.tsx');
    const sourceText = fs.readFileSync(surfacePath, 'utf8');
    expect(findControllerKindAccesses(surfacePath, sourceText)).toEqual([]);
  });

  it('holds managed-host.tsx transitive daemon value-import edges to the exact ratchet allowlist', () => {
    const edges = collectManagedHostDaemonValueEdges(MANAGED_HOST_ENTRY);
    expect(edges).toEqual(REMAINING_MANAGED_HOST_DAEMON_EDGES);
  });

  it('detects synthetic daemon imports, mixed type/value imports, dynamic imports, and controller.kind accesses', () => {
    const syntheticImports = extractModuleSpecifiers(
      'synthetic.tsx',
      [
        `import type { DaemonEvent } from '@qwen-code/sdk/daemon';`,
        `import { type DaemonClient, DaemonHttpError } from '@qwen-code/sdk/daemon';`,
        `export { foo } from '../daemon/timing';`,
        `const load = () => import('../daemon/session/turn-navigation-store');`,
      ].join('\n'),
    );
    expect(syntheticImports).toEqual([
      { specifier: '@qwen-code/sdk/daemon', isTypeOnly: true },
      { specifier: '@qwen-code/sdk/daemon', isTypeOnly: false },
      { specifier: '../daemon/timing', isTypeOnly: false },
      {
        specifier: '../daemon/session/turn-navigation-store',
        isTypeOnly: false,
      },
    ]);
    expect(
      syntheticImports.every((entry) => isDaemonSpecifier(entry.specifier)),
    ).toBe(true);

    expect(
      findControllerKindAccesses(
        'synthetic.tsx',
        `// controller.kind in comment is ignored\nconst x = controller.kind === 'daemon';`,
      ),
    ).toEqual([2]);
  });
});
