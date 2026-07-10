/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

describe('comment attachment guard workflow', () => {
  const workflow = readFileSync(
    path.join(repoRoot, '.github/workflows/comment-attachment-guard.yml'),
    'utf8',
  );

  it('treats common URL punctuation after a risky extension as a match boundary', () => {
    expect(workflow).toContain('>?#/&;.,!:]');
  });

  it('checks markdown link URLs instead of display text', () => {
    expect(workflow).toContain('const url = mdMatch ? mdMatch[1] : snippet;');
    expect(workflow).toContain(
      'return highRiskExtension.test(highRiskTarget(url));',
    );
  });

  it('checks URL paths instead of country-code TLD hosts', () => {
    expect(workflow).toContain('const parsedUrl = new URL(url);');
    expect(workflow).toContain(
      '${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}',
    );
  });

  it('does not throw on malformed URL-like links', () => {
    expect(workflow).toContain('} catch {\n                return target;');
  });

  it('decodes escaped risky extensions in URL paths', () => {
    expect(workflow).toContain('return decodeURIComponent(target);');
  });

  it('keeps parenthesized URL segments in link matches', () => {
    expect(workflow).toContain(
      String.raw`/https?:\/\/[^\s"'<>\]]+|\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\)/gi;`,
    );
  });

  it('keeps diagnostics when deletion or summary writing fails', () => {
    expect(workflow).toContain(
      'Failed to delete suspicious comment ${comment.id}',
    );
    expect(workflow).toContain('Failed to write suspicious comment summary');
  });

  it('only reports a removed suspicious comment after deletion succeeds', () => {
    expect(workflow).toContain('let deleted = false;');
    expect(workflow).toContain('if (!deleted) {');
  });
});
