/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mechanical drift guard for the voice code mirrored between the CLI (npm
 * workspace) and desktop (bun workspace). The workspace boundary prevents
 * sharing a module, and drift here makes the two surfaces disagree about the
 * voice network policy — silently, and in the unsafe direction. A comment is
 * not a mechanism, so the mirrored units are compared mechanically instead.
 *
 * Units are compared as parse trees: each unit is parsed with TypeScript and
 * re-printed canonically with comments removed, single-statement blocks
 * unwrapped, and the `export` modifier dropped, because the two sides
 * intentionally differ only in formatting (brace style, comments, exports).
 * Literal contents and statement structure are compared exactly, so drift
 * hidden inside a string, template, regex, or block is still caught.
 *
 * Not covered: mirrors with intentionally different shapes (trusted-settings
 * merge, env-var interpolation, storage paths). Those stay comment-guarded
 * and are pinned by the desktop parity tests.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

export const MIRROR_SETS = [
  {
    cli: 'packages/cli/src/services/voice-transcriber.ts',
    desktop: 'packages/desktop/packages/server-core/src/voice/net-guard.ts',
    units: [
      { kind: 'block', name: 'BLOCKED_TRANSITION_IPV6_ADDRESSES' },
      { kind: 'function', name: 'normalizeHostname' },
      { kind: 'function', name: 'normalizeIpAddress' },
      { kind: 'function', name: 'isLoopbackHost' },
      { kind: 'function', name: 'isAwsIpv6MetadataAddress' },
      { kind: 'function', name: 'readIpv4CompatibleIpv6' },
      { kind: 'function', name: 'readIpv4MappedIpv6' },
      { kind: 'function', name: 'readIpv4HexPair' },
      { kind: 'function', name: 'readWellKnownNat64Ipv6' },
      { kind: 'function', name: 'isBlockedTransitionIpv6Address' },
      { kind: 'function', name: 'unwrapIpv6TransitionStep' },
      { kind: 'function', name: 'isPrivateNetworkIp' },
      { kind: 'function', name: 'isAlwaysBlockedVoiceAddress' },
      { kind: 'function', name: 'isLoopbackVoiceAddress' },
      { kind: 'function', name: 'defaultLookupHost' },
    ],
  },
  {
    cli: 'packages/cli/src/ui/voice/voice-stream-session.ts',
    desktop:
      'packages/desktop/packages/server-core/src/voice/voice-stream-session.ts',
    units: [
      { kind: 'function', name: 'deriveWebSocketBase' },
      { kind: 'function', name: 'deriveStreamUrl' },
    ],
  },
];

const PRINTER = ts.createPrinter({ removeComments: true });

/**
 * Absorb brace-style differences by replacing a block that wraps a single
 * statement with that statement, in the positions where the bare statement
 * form is also valid (`if (x) { return; }` vs `if (x) return;`). Blocks with
 * more than one statement keep their shape, so moving a statement into or
 * out of a block still reads as drift.
 */
function unwrapSingleStatementBlock(statement) {
  let body = statement;
  while (
    body &&
    body.kind === ts.SyntaxKind.Block &&
    body.statements.length === 1
  ) {
    body = body.statements[0];
  }
  return body;
}

function unwrapSingleStatementBlocks(node) {
  if (node.kind === ts.SyntaxKind.IfStatement) {
    node.thenStatement = unwrapSingleStatementBlock(node.thenStatement);
    if (node.elseStatement) {
      node.elseStatement = unwrapSingleStatementBlock(node.elseStatement);
    }
  } else if (
    node.kind === ts.SyntaxKind.ForStatement ||
    node.kind === ts.SyntaxKind.ForInStatement ||
    node.kind === ts.SyntaxKind.ForOfStatement ||
    node.kind === ts.SyntaxKind.WhileStatement ||
    node.kind === ts.SyntaxKind.DoStatement ||
    node.kind === ts.SyntaxKind.WithStatement ||
    node.kind === ts.SyntaxKind.LabeledStatement
  ) {
    node.statement = unwrapSingleStatementBlock(node.statement);
  }
  ts.forEachChild(node, unwrapSingleStatementBlocks);
}

/**
 * Detach nodes from their source positions so the printer emits its own
 * canonical layout instead of preserving the original line breaks.
 */
function stripSourceLayout(node) {
  node.pos = -1;
  node.end = -1;
  if (node.multiLine) {
    node.multiLine = false;
  }
  ts.forEachChild(node, stripSourceLayout);
}

/**
 * Normalize mirrored code for comparison: parse it and re-print it
 * canonically. The two sides intentionally differ only in comments,
 * formatting, brace style for single statements, and the `export` modifier;
 * everything else — including literal contents and statement structure — is
 * significant.
 */
export function normalizeMirroredCode(text) {
  const sourceFile = ts.createSourceFile(
    'voice-guard-unit.ts',
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  return sourceFile.statements
    .map((statement) => {
      if (statement.modifiers) {
        statement.modifiers = statement.modifiers.filter(
          (modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword,
        );
      }
      unwrapSingleStatementBlocks(statement);
      stripSourceLayout(statement);
      return PRINTER.printNode(ts.EmitHint.Unspecified, statement, sourceFile);
    })
    .join('\n');
}

/**
 * Extract a top-level unit (a `function` declaration or a const+for block
 * such as the BlockList setup) as the lines from its declaration through the
 * next column-0 `}`, which closes a top-level body in prettier-formatted
 * code.
 */
export function extractTopLevelUnit(source, unit) {
  const pattern =
    unit.kind === 'function'
      ? new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${unit.name}\\(`)
      : new RegExp(`^const\\s+${unit.name}\\b`);
  const lines = source.split('\n');
  let startLine = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (pattern.test(lines[k])) {
      startLine = k;
      break;
    }
  }
  if (startLine === -1) return undefined;
  for (let k = startLine + 1; k < lines.length; k += 1) {
    if (lines[k] === '}') {
      return lines.slice(startLine, k + 1).join('\n');
    }
  }
  return undefined;
}

/** Returns one entry per unit that is missing or has drifted. */
export function checkMirrorSet(cliSource, desktopSource, units) {
  const drift = [];
  for (const unit of units) {
    const cliUnit = extractTopLevelUnit(cliSource, unit);
    const desktopUnit = extractTopLevelUnit(desktopSource, unit);
    if (!cliUnit || !desktopUnit) {
      const missing = !cliUnit
        ? !desktopUnit
          ? 'missing in both files'
          : 'missing in the CLI file'
        : 'missing in the desktop file';
      drift.push({ name: unit.name, reason: missing });
      continue;
    }
    if (normalizeMirroredCode(cliUnit) !== normalizeMirroredCode(desktopUnit)) {
      drift.push({ name: unit.name, reason: 'bodies differ' });
    }
  }
  return drift;
}

function main() {
  let failed = false;
  for (const mirrorSet of MIRROR_SETS) {
    const cliSource = readFileSync(join(root, mirrorSet.cli), 'utf8');
    const desktopSource = readFileSync(join(root, mirrorSet.desktop), 'utf8');
    const drift = checkMirrorSet(cliSource, desktopSource, mirrorSet.units);
    if (drift.length > 0) {
      failed = true;
      console.error(
        `\nVoice guard drift between ${mirrorSet.cli} and ${mirrorSet.desktop}:`,
      );
      for (const entry of drift) {
        console.error(`- ${entry.name}: ${entry.reason}`);
      }
    }
  }
  if (failed) {
    console.error(
      '\nMirrored voice network-guard code has drifted. Update both sides ' +
        'together: the classification decides whether voice audio may use an ' +
        'insecure or private endpoint, and the surfaces must agree.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('Voice guard mirror check passed.');
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main();
}
