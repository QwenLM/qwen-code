# Notebook read recovery

[English](2026-09-21-notebook-read-recovery.md) | [简体中文](2026-09-21-notebook-read-recovery.zh-CN.md)

## Problem

Notebook reads reject `offset`, `limit`, and nonempty `pages`. In observed
benchmark sessions the model repeatedly changed the values instead of omitting
these fields. Setting `limit` to zero replaced the notebook error with a generic
positive-integer error, suggesting another change of value.

The Responses adapter also left `strict` unspecified. [OpenAI documents](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
that Responses may normalize such schemas into strict mode, where all properties
are required. The original upstream schema was not captured, so normalization is
a compatibility risk, not a confirmed explanation of those sessions.

## Change

- Send `strict: false` for converted Responses function tools to preserve the
  declared optional fields. Retain existing schema normalization and local
  validation; do not introduce nullable parameters or silently discard inputs.
- Describe notebook reads as structured cells with outputs and explicitly tell
  the model to omit pagination. Restrict line-pagination guidance to text files.
- After path validation and empty-`pages` normalization, check notebook pagination
  before numeric range validation. All schema-valid pagination values, including
  zero or negative integers and invalid PDF page strings, return the same
  instruction to omit the fields and a JSON-escaped, path-only retry example.
- Keep schema type validation first. Wrong types, including `null`, still fail
  schema validation. Empty or whitespace-only `pages` retains its existing
  omission behavior. Text ranges and PDF page validation retain their semantics.

## Validation and limits

Unit tests cover consistent notebook errors, a usable retry example, preserved
text/PDF validation, and outgoing optional parameters with `strict: false`.
Headless CLI tests use a local deterministic Responses endpoint to capture the
wire schema and verify failed calls followed by a successful path-only read.
Build, typecheck, focused tests, and independent review complete verification.

This does not add notebook pagination, relax loop protection, change compression,
or guarantee that every model follows a valid recovery instruction. The local
endpoint verifies client behavior, not the historical upstream transformation.
