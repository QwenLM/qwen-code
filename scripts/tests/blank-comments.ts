/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSourceFile,
  getLeadingCommentRanges,
  getTrailingCommentRanges,
  type Node,
  ScriptTarget,
} from 'typescript';

// Blank comments using the parser's own trivia ranges so a commented-out
// copy of a pinned line cannot satisfy a source pin. A raw createScanner walk
// is not safe here: it does not rescan the `}` of a `${...}` substitution as a
// template token (the parser calls reScanTemplateToken), so on the document
// gate's interpolated RENDERER_URL / RENDERER_CSS_URL templates it desyncs and
// blanks none of the comments after them. A /\*[\s\S]*?\*\// regex is not
// safe either: that gate's page.route('**/*') glob contains "/*", which a
// blanket regex reads as a comment opener, blanking the rest of the file and
// swallowing the real assertion. Newlines survive so line anchors keep their
// line structure.
export function blankComments(source: string): string {
  const sourceFile = createSourceFile(
    'pinned-source.ts',
    source,
    ScriptTarget.Latest,
    true,
  );
  const ranges: { pos: number; end: number }[] = [];
  const collect = (node: Node) => {
    ranges.push(...(getLeadingCommentRanges(source, node.pos) ?? []));
    ranges.push(...(getTrailingCommentRanges(source, node.end) ?? []));
    // getChildren, not forEachChild: punctuation tokens own trivia too (a
    // block comment before a call's closing paren is leading trivia of the
    // CloseParenToken), and forEachChild never visits them.
    for (const child of node.getChildren()) collect(child);
  };
  collect(sourceFile);
  // Comments after the last statement are leading trivia of the EOF token;
  // collect it explicitly in case the child walk ever skips it.
  const eof = sourceFile.getChildAt(sourceFile.getChildCount() - 1);
  ranges.push(...(getLeadingCommentRanges(source, eof.pos) ?? []));
  ranges.sort((a, b) => a.pos - b.pos);
  let out = '';
  let last = 0;
  for (const { pos, end } of ranges) {
    if (pos < last) continue;
    out +=
      source.slice(last, pos) + source.slice(pos, end).replace(/[^\n]/g, ' ');
    last = end;
  }
  return out + source.slice(last);
}
