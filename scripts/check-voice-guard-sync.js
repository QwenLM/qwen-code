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
 * Units are compared after normalization: comments, whitespace, braces, and
 * the `export` modifier are dropped, because the two sides intentionally
 * differ only in formatting (brace style, comments, exports).
 *
 * Not covered: mirrors with intentionally different shapes (trusted-settings
 * merge, env-var interpolation, storage paths). Those stay comment-guarded
 * and are pinned by the desktop parity tests.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// A `/` starts a regex literal (not division) when the previous significant
// token is one of these keywords or a non-closing punctuator.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'case',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Strip `//` and block comments while preserving strings, template literals
 * (including `${...}` interpolations), and regex literals — all of which can
 * legally contain comment-looking sequences such as `http://`.
 */
export function stripComments(source) {
  const n = source.length;
  let out = '';
  let i = 0;
  let lastIdent = '';
  let lastChar = '';

  const note = (text) => {
    for (const ch of text) {
      if (/[A-Za-z0-9_$]/.test(ch)) {
        lastIdent = /[A-Za-z0-9_$]/.test(lastChar) ? lastIdent + ch : ch;
        lastChar = ch;
      } else if (!/\s/.test(ch)) {
        lastIdent = '';
        lastChar = ch;
      }
    }
  };

  const regexAllowed = () => {
    if (lastChar === '') return true;
    if (lastChar === ')' || lastChar === ']' || lastChar === '}') {
      return false;
    }
    if (/[A-Za-z0-9_$]/.test(lastChar)) {
      return REGEX_PRECEDING_KEYWORDS.has(lastIdent);
    }
    return true;
  };

  const scanString = (start, quote) => {
    let j = start;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === quote || c === '\n') {
        return j + 1;
      }
      j += 1;
    }
    return j;
  };

  const scanTemplateExpression = (start) => {
    let depth = 1;
    let j = start;
    while (j < n && depth > 0) {
      const c = source[j];
      if (c === "'" || c === '"') {
        j = scanString(j + 1, c);
        continue;
      }
      if (c === '`') {
        j = scanTemplate(j + 1);
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      j += 1;
    }
    return j;
  };

  const scanTemplate = (start) => {
    let j = start;
    while (j < n) {
      const c = source[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        return j + 1;
      }
      if (c === '$' && source[j + 1] === '{') {
        j = scanTemplateExpression(j + 2);
        continue;
      }
      j += 1;
    }
    return j;
  };

  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      i = newline === -1 ? n : newline;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j += 1;
      }
      if (j >= n || source[j] !== '/') {
        // Unterminated: not a regex literal after all.
        out += ch;
        note(ch);
        i += 1;
        continue;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(source[j])) j += 1;
      const literal = source.slice(i, j);
      out += literal;
      note(literal);
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const j = scanString(i + 1, ch);
      const literal = source.slice(i, j);
      out += literal;
      note(literal);
      i = j;
      continue;
    }
    if (ch === '`') {
      const j = scanTemplate(i + 1);
      const literal = source.slice(i, j);
      out += literal;
      note(literal);
      i = j;
      continue;
    }
    out += ch;
    note(ch);
    i += 1;
  }
  return out;
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

/**
 * Normalize mirrored code for comparison: the two sides intentionally differ
 * only in comments, formatting, brace style for single statements, and the
 * `export` modifier.
 */
export function normalizeMirroredCode(text) {
  return stripComments(text)
    .replace(/\s+/g, '')
    .replace(/^export/, '')
    .replace(/[{}]/g, '');
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
