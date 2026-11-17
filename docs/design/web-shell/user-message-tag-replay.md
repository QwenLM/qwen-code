# Preserve user-message tags in saved history

[English](user-message-tag-replay.md) | [简体中文](user-message-tag-replay.zh-CN.md)

## Problem and scope

Live Web Shell messages carry `inputAnnotations`, but ACP user-message recording omits them. Idle-session refresh and disk-backed history replay therefore restore reference text without tags. Preserve submitted file, MCP, extension, and custom reference annotations using the existing transcript payload and replay metadata.

## Design

- Add optional, opaque `inputAnnotations` to `UserPromptRecordPayload`. Core stores UI metadata without depending on SDK UI types or adding it to model input.
- ACP snapshots the request annotation array alongside its display text when recording ordinary prompts and deferred custom `/advisor` prompts. Retry and continuation keep the original record. Only the annotation field is copied; unrelated request metadata is excluded.
- The shared transcript replay machine forwards saved annotation arrays through user-update `_meta`. Existing SDK normalization and Web Shell rendering then restore tags, including paged history and reopening a saved session.
- Use existing array guards and the renderer's reference/range checks. Missing or non-array annotation fields are ignored, and non-object elements are skipped at recording, replay, and render time. Do not infer references from raw text; older records without annotations remain plain text.
- The unified read-only chip style intentionally applies to every `ReadonlyComposerTag` consumer, including the queued-prompt strip. The composer editor's own tag chips keep their existing file/non-file styling; restyling the composer is out of scope.

## Consumers and constraints

The new field is written by ACP, stored unchanged by the recorder, and read by the shared replay machine used by CLI history loading/paging and SDK chat-record projection. TUI/headless recording, session titles, model history, and attachment previews retain their current inputs. No routes, caches, schema migrations, or runtime ownership changes are required.

## Validation and acceptance

- Reproduce real prompt recording and disk reload; distinguish global CLI behavior from the current worktree and identify any mocked provider.
- Regression tests cover file/MCP/extension recording, snapshot ownership, replayed annotations, and unchanged model text. Missing/malformed outer metadata must not create annotations.
- Browser reload displays tags from saved records; long labels remain truncated and file-style appearance remains consistent.
- Run affected package tests, build, bundle, typecheck, formatting, lint, and inspect the complete diff.
