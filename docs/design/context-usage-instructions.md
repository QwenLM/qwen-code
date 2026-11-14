# Context usage instruction accounting

[English](context-usage-instructions.md) | [简体中文](context-usage-instructions.zh-CN.md)

## Problem and scope

Context usage groups user/project/extension instructions and managed auto memory
under Memory files. Separate these categories in the API, formatted text, Ink,
OpenTUI and Web Shell without changing prompt loading or token estimation.

## Contract and compatibility

Add optional `instructionFiles` to the breakdown (tokens) and usage (path/token
details). New producers always populate both fields, including empty results.
`memoryFiles` then contains only auto-memory policy and catalog snapshots.
Both categories participate in overhead scaling and accounting exactly once.

Optional fields allow historical transcripts and older daemons to render. When
the breakdown lacks `instructionFiles`, preserve the legacy Memory files label;
otherwise label `memoryFiles` Auto memory. Do not infer classification from paths
or localized labels. Old clients still display memoryFiles but will not display
the new instruction category; upgrade clients to see the complete breakdown.

## Validation and acceptance

Verify mixed instructions and auto memory, empty categories, detail off/on,
provider totals with and without scaling, and legacy payloads. All displays must
show the split, retain extension ownership and preserve total-token accounting.
Use focused producer, transport and renderer tests plus build/typecheck and an
independent baseline/candidate probe. No memory write or retrieval behavior changes.
