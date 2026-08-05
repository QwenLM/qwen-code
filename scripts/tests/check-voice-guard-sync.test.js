/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkMirrorSet,
  extractTopLevelUnit,
  normalizeMirroredCode,
  stripComments,
} from '../check-voice-guard-sync.js';

const checkScriptPath = fileURLToPath(
  new URL('../check-voice-guard-sync.js', import.meta.url),
);

const CLI_STYLE = [
  'function isPrivate(host: string): boolean {',
  '  // Blocks IP-literal private networks only.',
  '  if (isLoopbackHost(host)) {',
  '    return false;',
  '  }',
  '  return host.startsWith("10.");',
  '}',
].join('\n');

const DESKTOP_STYLE = [
  'export function isPrivate(host: string): boolean {',
  '  /** Different comment. */',
  '  if (isLoopbackHost(host)) return false;',
  '  return host.startsWith("10.");',
  '}',
].join('\n');

describe('check-voice-guard-sync', () => {
  it('ignores comments, whitespace, brace style, and the export modifier', () => {
    expect(
      checkMirrorSet(CLI_STYLE, DESKTOP_STYLE, [
        { kind: 'function', name: 'isPrivate' },
      ]),
    ).toEqual([]);
  });

  it('reports a changed body as drift', () => {
    const drifted = DESKTOP_STYLE.replace('10.', '172.');
    expect(
      checkMirrorSet(CLI_STYLE, drifted, [
        { kind: 'function', name: 'isPrivate' },
      ]),
    ).toEqual([{ name: 'isPrivate', reason: 'bodies differ' }]);
  });

  it('reports a unit missing from one side', () => {
    expect(
      checkMirrorSet(CLI_STYLE, '', [{ kind: 'function', name: 'isPrivate' }]),
    ).toEqual([{ name: 'isPrivate', reason: 'missing in the desktop file' }]);
    expect(
      checkMirrorSet('', DESKTOP_STYLE, [
        { kind: 'function', name: 'isPrivate' },
      ]),
    ).toEqual([{ name: 'isPrivate', reason: 'missing in the CLI file' }]);
  });

  it('extracts a function up to its column-0 closing brace', () => {
    const source = `${DESKTOP_STYLE}\n\nfunction next(): void {}\n`;
    expect(
      extractTopLevelUnit(source, { kind: 'function', name: 'isPrivate' }),
    ).toBe(DESKTOP_STYLE);
  });

  it('extracts a const+for block unit', () => {
    const block = [
      'const BLOCKS = new BlockList();',
      "for (const [address, prefix] of [['2001::', 23]] as const) {",
      "  BLOCKS.addSubnet(address, prefix, 'ipv6');",
      '}',
    ].join('\n');
    const source = `${block}\n\nfunction next(): void {}\n`;
    expect(extractTopLevelUnit(source, { kind: 'block', name: 'BLOCKS' })).toBe(
      block,
    );
  });

  it('does not treat comment-looking sequences in strings as comments', () => {
    const source = [
      'function url(host: string): string {',
      '  return `http://[${host}]/`;',
      '}',
    ].join('\n');
    expect(stripComments(source)).toContain('http://[${host}]/');
    expect(normalizeMirroredCode(source)).toContain('http://');
  });

  it('passes on the real mirrored sources', () => {
    const output = execFileSync(process.execPath, [checkScriptPath], {
      encoding: 'utf8',
    });
    expect(output).toContain('Voice guard mirror check passed.');
  });
});
