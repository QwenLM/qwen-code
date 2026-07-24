# CLI Inline Math Recognition

## Problem

Qwen Code's terminal Markdown renderer supports inline `$...$` math, but its
recognition rule is repeated across rendering, table parsing, source-copy
selection, and streaming bookkeeping. The current rule rejects valid
single-character formulas, can treat an escaped dollar as a delimiter, and
allows source-copy selection to disagree with what the terminal renders.

This creates three user-visible inconsistencies:

- `$x$` remains raw even though longer formulas render;
- `\$xy$` can render as math despite being escaped;
- inline code can remain literal on screen while `/copy inline-latex` extracts
  math from inside it.

## Current State

The accepted baseline is the current `main` branch containing the terminal
Markdown work from PR #3680, not the older pre-rendering implementation and not
the unmerged renderer from PR #3439.

The baseline provides:

- lightweight Unicode rendering for common LaTeX commands;
- inline `$...$` and line-delimited `$$...$$`;
- raw/render mode switching;
- source recovery through `/copy latex` and `/copy inline-latex`;
- bounded inline spans and streaming fallbacks.

The same inline pattern currently appears in the inline React renderer, table
ANSI renderer, table row splitter, and copy command. Display fence handling is
also duplicated between `MarkdownDisplay` and the copy command.

## Proposed Changes

### Shared inline contract

Add a small CLI-local utility that defines:

- bounded inline math recognition;
- escaped-delimiter handling;
- the inline-code boundary used to exclude literal spans;
- extraction of content from a recognized `$...$` span.

The utility owns only the delimiter recognition needed to keep math rendering
and source selection aligned. It does not parse or render TeX.

### Recognition fixes

Recognize single-character formulas such as `$x$`, but do not recognize dollar
delimiters whose opening `$` is escaped. Keep the existing 1024-character bound
and conservative currency/shell-variable heuristics.

Use the shared contract for ordinary Markdown, table cells, table column
splitting, and `/copy inline-latex`. Copy selection must additionally skip
inline code spans just as the visual renderer does.

### Tests

Add focused regression coverage for:

- rendering and source copying for single-character formulas;
- escaped dollars, prices, and shell variables;
- code spans and fenced code blocks;
- table cells containing pipes inside math;
- the 1024/1025-character boundary;
- CJK-adjacent formulas and unclosed inline delimiters.

## Files Affected

- `packages/cli/src/ui/utils/inline-math.ts`
- `packages/cli/src/ui/utils/InlineMarkdownRenderer.tsx`
- `packages/cli/src/ui/utils/TableRenderer.tsx`
- `packages/cli/src/ui/utils/pending-rendered-height.ts`
- `packages/cli/src/ui/commands/copyCommand.ts`
- collocated tests for the files above
- `integration-tests/terminal-capture/scenarios/markdown-rendering.ts`

## Design Decisions

- Build on current `main`; use PR #3439 only as prior-art and adversarial-test
  input.
- Keep the existing lightweight renderer. Fractions, matrices, cases, and
  full terminal TeX layout are outside this change.
- Keep inline recognition CLI-local. A cross-surface fixture package can be
  considered after the CLI contract is proven without forcing a cross-package
  change into this PR.
- Prefer source fallback over guessing when delimiters are escaped, overlong, or
  unclosed.

## Scope Boundaries

This change does not:

- replace the Markdown parser with an AST pipeline;
- add KaTeX or another terminal dependency;
- change Web Shell rendering;
- add `\(...\)` or `\[...\]` aliases;
- add arbitrary TeX macros or environments;
- change display-math parsing or streaming split behavior;
- change export formats or model prompting.

## Open Questions

None required for the first implementation. Delimiter aliases, display-math
streaming boundaries, broader terminal layout, and a language-neutral
cross-client fixture corpus remain follow-up work.
