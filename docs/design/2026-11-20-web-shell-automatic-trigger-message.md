# Web Shell automatic-trigger message display

[English](2026-11-20-web-shell-automatic-trigger-message.md) | [简体中文](2026-11-20-web-shell-automatic-trigger-message.zh-CN.md)

## Problem and current state

A self-paced `/loop` wakeup or a cron fire is recorded as a user-role transcript entry with `source: 'loop'` or `source: 'cron'`. Its prompt is not a message that the person typed at that moment.

Web Shell currently renders every user-role entry through the ordinary `UserMessage` bubble. A long continuation prompt therefore appears as a large user bubble on every tick. In the motivating session, six automatic entries contained 640–915 characters each and repeated much of their state and constraints. The source already drives a timeline clock, but not the message body.

The existing `ScheduledTaskRunMessage` handles the structured prompt of an independent per-run scheduled task. It does not cover ordinary in-session cron fires or self-paced `/loop` wakeups. Issue #17267 tracks pending-wakeup visibility and is complementary; it does not cover this transcript display.

## Goals

- Render ordinary `cron` and `loop` inputs as compact automatic-trigger cards rather than ordinary user bubbles.
- Show a one-line prompt summary and preserve the existing outer message timestamp semantics.
- Make detailed display text available through an explicit disclosure when it adds useful content beyond the summary.
- Preserve the existing per-run scheduled-task card, attachments, message editing, retry, source metadata, and turn/tool-call behavior.
- Keep static document exports readable without requiring interaction.
- Avoid constructing rich content that is hidden behind a closed disclosure.

## Scope boundaries

- Limit this part to Web Shell presentation, the existing document-export projection needed for that presentation, and the measured renderer budget. Do not change scheduling, cancellation, model input, transcript recording, replay metadata, or daemon APIs.
- Do not regroup ticks under a loop, invent a loop iteration number or chain ID, or create a session per tick.
- Do not add pending-wakeup badges, scheduled-task controls, or a new settings option.
- Do not change the meaning or editability of automatic user turns in this slice.
- Do not claim that `message.timestamp` is the scheduler's actual fire time: queued execution can make it later than `firedAt`, and that separate value is not available to this UI projection.
- Do not claim to expose full `modelText` for autonomous or `loop.md` ticks whose persisted `displayText` intentionally contains only a short echo. No model-input audit protocol is added in this slice.

## Proposed changes

### Message wiring

`MessageItem` passes the existing `message.source` to `UserMessage`, and `MessageList` shares the same source predicate so its timeline cannot disagree with the body. Its memo comparison also compares filenames, MIME types, text previews, attachment IDs, and Blob identities so file-only updates reach the disclosure. The existing outer `MessageTimestamp` remains the only timestamp display and keeps its current meaning.

### Versioned document-export source projection

Offline replay restores a persisted cron subtype to `DaemonTextTranscriptBlock.meta.source`. Published V1 deliberately excludes that metadata, so V1 cannot show the automatic-trigger presentation for a real exported wakeup. Do not widen V1 in place: V2 permits only an optional user-block `meta.source: 'cron'`, derived from the unmodified V1 schema and used by new HTML output. The V1 producer and reader retain their existing closed field set and do not accept it; the renderer accepts both V1 and V2 documents and rejects other versions. The V2 tag carries no timestamp, source record ID, or other surrounding metadata, and the forbidden-field gate still admits only the exporter-generated single-key object. This changes the outbound HTML document envelope, not scheduling, transcript persistence, replay metadata generation, or daemon APIs. It does not change the meaning of `rendererVersion`, which remains an exact CLI version or content hash and is not the document's `schemaVersion`.

`build.mjs` emits `EXPORT_TRANSCRIPT_DOCUMENT_MAX_SCHEMA_VERSION` alongside that identity. A local source build supports V2. A delegated renderer defaults to V1 so its previously published runtime can still open every exported document. To delegate a V2-capable renderer, the caller must explicitly set `QWEN_EXPORT_RENDERER_SCHEMA_MAX_VERSION=2` and pin the renderer identity plus JS/CSS SRI hashes for that same capable runtime. The build measures the asset after injecting its identity, not the placeholder-bearing intermediate text.

### Automatic-trigger presentation

`UserMessage` selects the automatic-trigger presentation only when:

1. `source` is exactly `cron` or `loop`; and
2. the content does not match the existing structured per-run scheduled-task prompt.

The card uses the same automatic-trigger label for both sources. Persisted replay currently normalizes both to `cron`, so a source-specific Loop label would change appearance after reload.

The summary is the original display text with whitespace collapsed, truncated visually with CSS rather than by shortening stored or copied text. No schedule or task metadata is inferred from prompt text.

Interactive and readonly views default to the compact summary. The existing Show more/Collapse disclosure reveals the complete display text through the existing user-content rendering pipeline, including annotations, links, slash highlighting, attachment references, and host customization. Even a short ordinary prompt keeps this control so a narrow layout never removes access to its full text.

Only the runtime's complete short echo forms—`Autonomous loop tick`, `Loop tick — tasks from project loop.md`, `Loop tick — tasks from home loop.md`, and `Loop tick — loop.md temporarily unavailable`—render as static compact cards with no disclosure. Their full labels wrap on narrow layouts rather than being ellipsized, so no extra disclosure is needed simply to read the label itself. A real prompt or unrecognized future source label that merely shares the `Loop tick — ` prefix keeps its disclosure in interactive and readonly views and its complete text in exported documents; the matcher fails open.

Document mode follows `TranscriptDocumentExpandedContext`, whose default is expanded, and exposes no interactive disclosure. Detailed content is included by default; a short echo needs no duplicate body and is rejected before the built-in parser is invoked.

Rich content is constructed lazily on the built-in renderer path. A closed interactive disclosure does not invoke the default parser. Expansion constructs it once, and default-expanded document output still constructs it. Source, content, image-count, file-count, and editing changes identify a new presentation generation. Comparing those fields through React state, rather than render-mutated refs, collapses the outgoing detail before any new parser work and keeps deferred or abandoned transitions from leaking state into the committed presentation. The generation identity compares fields directly rather than repeatedly constructing full-prompt strings. When a host supplies `renderUserMessageContent`, `parseUserMessageContent`, or a custom composer-tag renderer, the automatic-card variant is bypassed so the host's previous complete-content replacement or redaction contract remains authoritative; the raw summary is never reintroduced around that output. The summary and echo predicate are memoized by source/content, so editing drafts do not rescan an unchanged instruction.

The existing bubble and selectors remain in place. A dedicated selector and `data-source` attribute identify the new presentation for browser tests. Images, files, retry affordances, and the inline editor stay in their current outer layout; editing continues to use the complete original text.

The generic 400 px overflow disclosure is disabled for automatic-trigger cards so users never need two successive expansions. Automatic variants do not measure an unused overflow flag or subscribe a ResizeObserver; ordinary and per-run messages retain their existing height measurement.

### Styling and localization

Add scoped styles to `UserMessage.module.css`, reusing the existing scheduled-task visual tokens, icon treatment, and semantic colors. Keep the automatic-trigger header on one flex line with `flex-wrap: nowrap`, leaving the shared per-run header unchanged. `.scheduledTaskHeading` shrinks within the available width, while a complete runtime echo wraps only inside its own summary. Add English `userMessage.automatic.title` in `i18n.tsx`, Simplified Chinese in `i18n-zh-cn.ts`, Traditional Chinese in `i18n-zh-tw.ts`, and Russian in `i18n-ru-part5.ts`, so every supported catalog displays a localized eyebrow.

## Key design decisions

| Decision                                                  | Rationale                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change the `UserMessage` variant, not the transcript role | User-role entries remain turn starts, while existing edit, delete, retry, timeline, and tool-call consumers continue to see the same message.                                                                                            |
| Integrate inside `UserMessage`                            | This preserves attachments, custom content rendering, editing, failure handling, and the per-run card without a parallel message path.                                                                                                   |
| Prefer the existing per-run card                          | Its structured task name, cron, task ID, trigger, and session mode are more informative than a generic automatic card.                                                                                                                   |
| Use one source-neutral visible label                      | Replay maps persisted automatic records to `cron`; the UI must not relabel the same tick after reload.                                                                                                                                   |
| Keep the existing outer timestamp only                    | The available value is a projection/execution timestamp, not necessarily the scheduler fire time, and a second card timestamp would duplicate and overstate it.                                                                          |
| Suppress redundant short-echo disclosure                  | The compact echo is already complete and the full model instruction is unavailable to this projection, so a full-instructions control would be both useless and misleading.                                                              |
| Construct detail content on demand                        | Long sessions should not parse or host-render every hidden instruction merely to show a compact summary.                                                                                                                                 |
| Do not group by wakeup ID                                 | Self-paced rearming creates a new one-shot ID, so it is not a stable loop-chain identity.                                                                                                                                                |
| Version the export instead of widening V1                 | The V1 allowlist is a safety contract. V2 carries only the existing canonical cron routing tag. The writer follows the renderer's declared schema ceiling: the current local renderer emits V2, and a pre-V2 delegate keeps emitting V1. |

## Files affected

- `packages/web-shell/client/utils/automatic-trigger.ts` and `.test.ts` — shared source and fail-open echo predicates.
- `packages/web-shell/client/components/MessageList.tsx` — use that predicate for timeline classification.
- `packages/web-shell/client/components/MessageItem.tsx` — pass source and preserve file-attachment updates through memo identity.
- `packages/web-shell/client/components/messages/UserMessage.tsx` — select the compact variant, preserve host overrides, and lazily construct details.
- `packages/web-shell/client/components/messages/UserMessage.module.css` — scoped card and disclosure styles.
- `packages/web-shell/client/i18n.tsx`, `i18n-zh-cn.ts`, `i18n-zh-tw.ts`, and `i18n-ru-part5.ts` — labels for every supported catalog.
- `packages/web-shell/client/i18n.test.ts` — localized catalog coverage.
- `packages/web-shell/client/components/MessageItem.dom.test.tsx` — prop forwarding and source-update coverage.
- `packages/web-shell/client/components/messages/UserMessage.test.tsx` — component behavior and regression coverage.
- `packages/web-templates/src/export-html/build.mjs` — schema-capability generation, delegation compatibility, and emitted-asset budget measurement.
- `packages/web-templates/src/index.ts` — expose the renderer schema ceiling to the HTML formatter.
- `packages/cli/src/ui/utils/export/export-transcript-document.ts` — preserve the V1 representation and add V2 plus its derived schema for the canonical cron routing tag, without admitting surrounding metadata.
- `packages/cli/src/ui/utils/export/index.ts` — export both versioned factories and document types alongside the existing V1 interface.
- `packages/cli/src/ui/utils/export/formatters/html.ts` — select the HTML schema version from the renderer's declared ceiling and validate either supported version on read.
- `packages/cli/src/ui/utils/export/export-transcript-document.test.ts` — V2 source and metadata-boundary coverage, non-cron sources, and V1 compatibility.
- `packages/cli/src/ui/utils/export/formatters/html.test.ts` — default and delegated schema ceilings, standalone and legacy HTML output, and invalid configuration coverage.
- `packages/web-templates/src/export-html/src/document-main.tsx` — accept V1 and V2 while rejecting other schema versions.
- `docs/design/web-shell/chat-transcript-contract-prevalidation.md` — synchronized allowlist, versioning, and schema-production rules.
- `packages/web-shell/client/e2e/web-shell.automatic-trigger-message.spec.ts` — deterministic browser coverage and screenshots.

## Validation plan

After identity injection, the renderer measures **2,152,990 bytes** of JavaScript, including its user-metadata boundary and attachment-reference checks, and **2,427,188 bytes** of separated component CSS. The warning baseline is the measured **`2,152,990`**, with a hard ceiling of **`2,153,420` bytes**, preserving 430 bytes for toolchain variance. The rebaseline reflects the emitted metadata-validation work rather than hiding its growth behind the earlier placeholder measurement.

- Unit-test both `cron` and `loop`, ordinary/unknown sources, per-run priority, disclosure, short-echo suppression, lazy built-in rendering, attachments, editing, source, content, and attachment-count changes that synchronously collapse the outgoing detail before parser work, empty content, document expansion, and preservation of real `Loop tick — ` prefixed instructions in interactive and document views. Verify that the automatic-trigger title is localized for every supported catalog.
- Verify that changing only the source on an existing `MessageItem` updates the forwarded props, and that an ordinary expanded message becomes compact when its source becomes automatic.
- Run the focused Web Shell suites for user messages, automatic-trigger predicates, and all supported catalogs, then the repository build and typecheck required by the contributor workflow. Measure the emitted renderer bytes after identity injection, compare them with the documented warning peak, and keep the hard ceiling exactly 430 bytes above that peak. Keep the warning strictly below the ceiling and exercise no-warning-at-current-size and future-growth warning behavior.
- Assert that the calendar and summary stay on one flex row and, for detailed input, the disclosure stays on that row too, at desktop and phone widths. Keep complete short-echo labels wrapped and readable, continue isolating variant selection from shared per-run styling, and assert there is no horizontal page overflow.
- Cover every same-count attachment field update, the no-host per-run priority path, observer cleanup, and expand → edit → cancel → collapsed → reopen.
- Run a Playwright scenario with the same cron, loop, ordinary, and per-run fixtures against the baseline and changed build. Capture compact and expanded states at desktop and mobile widths and assert no horizontal document overflow.
- Assert V2 `schemaVersion: 2` for a persisted cron record, only `meta.source: 'cron'` on its user block, and no metadata on ordinary or `goal_runtime` inputs. Verify timestamp rejection, rejection of the new tag in V1, and generation of legacy V1 HTML. Regenerate an actual HTTP export and verify its V2 marker, compact state, and global collapse/expand behavior.
- Delegate the pre-V2 identity with its actual published SRI, assert a V1 envelope without added metadata, and open it with the published renderer. As a negative control, the same envelope labelled V2 must be rejected by that renderer. Restore the default V2 writer after the delegation case and reject unsupported or unpaired schema-ceiling configuration.
- Keep model-facing JSONL content and replay source assertions as regression evidence; no production changes are expected in those layers.

## Acceptance criteria

- Automatic inputs occupy a compact card by default instead of showing their full prompt in an ordinary bubble.
- Where detailed display text exists, one user action reveals it with the existing rich rendering intact; short echoes do not get a redundant or misleading disclosure.
- Ordinary user messages and structured per-run scheduled-task messages retain their current presentation.
- Built-in closed disclosures defer the default rich-content parser, while host-provided replacement or redaction rendering retains its complete ownership of the message body.
- Attachments, editing, retry, source metadata, existing timestamp semantics, turn boundaries, and tool-call navigation continue to work.
- The current local V2 renderer carries the canonical cron routing tag without surrounding metadata; a pre-V2 delegate writes compatible V1 instead. Readers accept V1 and V2, reject unknown versions, and include detailed display text by default without an interactive trigger disclosure.
- Focused tests and browser checks pass at desktop and mobile widths without horizontal overflow.

## Open questions

None for this display-only slice. Stable loop grouping and faithful fire-time/model-input projections require separate data designs and are intentionally deferred.
