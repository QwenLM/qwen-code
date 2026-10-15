# Notebook read recovery

[English](2026-09-21-notebook-read-recovery.md) | [简体中文](2026-09-21-notebook-read-recovery.zh-CN.md)

## Problem

Notebook reads reject `offset`, `limit`, and nonempty `pages`. In observed
benchmark sessions the model repeatedly changed the values instead of omitting
these fields. Setting `limit` to zero replaced the notebook error with a generic
positive-integer error, suggesting another change of value.

[OpenAI documents](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
that Responses may normalize tool schemas into strict mode, where every property
is required and optional values use `null`. The original upstream schema was not
captured, so normalization is a compatibility risk, not a confirmed explanation
of those sessions. The tool must accept nullable optional values without
requiring strict mode to be disabled.

## Change

- Preserve the existing Responses strict defaults. Do not globally disable or
  force strict mode, or introduce a generic coercion of arbitrary tool inputs.
- Declare `read_file`'s `offset`, `limit`, and `pages` as nullable. Keep only
  `file_path` required locally so both omitted and explicit-null arguments work.
  If the provider makes every property required, the nullable types already
  provide a valid representation for unused fields.
- Normalize these three fields from `null` to `undefined` before notebook,
  numeric, or page validation and before creating the invocation. This preserves
  descriptions, locations, full-read caching, and text/PDF read defaults.
- Describe notebook reads as structured cells with outputs. Restrict line
  pagination guidance to text files. Check notebook pagination before numeric
  ranges and give one error directing the model to omit fields or use `null`,
  with a JSON-escaped retry example containing all three null fields.
- Keep `file_path` non-nullable and validate other types normally. Reject actual
  notebook pagination, including zero and negative integers. Empty or whitespace
  `pages` keeps its existing omission behavior. Non-null text/PDF values retain
  their existing meaning.

## Validation and limits

Unit tests cover null normalization, strict-compatible nullable calls, usable
retry examples, full-read caching, and text/PDF behavior. Headless CLI tests use
local deterministic Chat Completions and Responses endpoints to capture schemas
and exercise omitted, nullable, and invalid arguments. Complete the build,
typecheck, focused tests, and independent review.

This does not add notebook pagination, relax loop protection, or change
compression. Local endpoints verify client behavior, not historical upstream
normalization or the probability that a real model follows recovery guidance.
