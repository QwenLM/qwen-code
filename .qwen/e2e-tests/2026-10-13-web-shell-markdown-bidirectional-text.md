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

## Scope limits

- Prose direction is inferred once at the message root. A later paragraph with
  a different leading direction still inherits the message-level base until
  per-node direction handling is added.
- Markdown table cells retain their existing physical left alignment; logical
  table alignment is a separate follow-up.

## Automated coverage

The Markdown stylesheet contract test pins automatic direction on message,
inline-code, and fenced-code elements together with the corresponding
`unicode-bidi` isolation rules. The Web Shell visual suite now drives the real
composer and mock-daemon stream with the mixed-direction response in both dark
and light themes. It checks the live DOM direction and isolation values before
capturing the streaming and Shiki-highlighted settled states. The existing
Markdown component suite guards the surrounding plain, Mermaid, and
custom-renderer behavior against regressions.

## Evidence

The local Chromium before/after capture uses the same mixed-direction input in
both panels. The revised panel keeps the Hebrew sentence and embedded LTR tokens
in reading order, and the mixed fenced block selects direction per line. The
four visual captures cover streaming and settled rendering in both themes. The
focused reproduction and Markdown component suites pass after the repair.
