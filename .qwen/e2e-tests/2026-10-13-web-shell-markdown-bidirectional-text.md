# WebShell Markdown bidirectional text

## Baseline

The global `qwen` CLI is not installed on the verification host. This behavior
belongs to the WebShell DOM renderer, so the executable baseline is the local
Chromium Markdown harness built from `main`. With an inherited LTR direction,
Hebrew prose containing an inline POSIX path and URL is visually reordered, and
the fenced block does not choose direction independently for each line.

## Scenario

Render an assistant response containing Hebrew prose, an inline LTR path, a
URL, and a fenced block with both Hebrew-leading and English-leading lines.
Compare the same content before and after the bidirectional text rules.

## Checks

- Hebrew-leading prose is right-to-left while its inline path and URL remain in
  readable left-to-right order.
- Each fenced-code line follows its own first strong directional character.
- Inline code is isolated from surrounding prose.
- An ordinary English-only Markdown response retains its existing layout.
- Streaming and settled Markdown use the same automatic base direction.

## Automated coverage

The Markdown stylesheet contract test pins automatic direction on message,
inline-code, and fenced-code elements together with the corresponding
`unicode-bidi` isolation rules. The existing Markdown component suite guards
the surrounding streaming, settled, highlighted, plain, Mermaid, and
custom-renderer behavior against regressions.

## Evidence

The local Chromium before/after capture uses the same mixed-direction input in
both panels. The revised panel keeps the Hebrew sentence and embedded LTR tokens
in reading order, and the mixed fenced block selects direction per line. The
focused reproduction and Markdown component suites pass after the repair.
