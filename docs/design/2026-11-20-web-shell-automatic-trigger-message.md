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

- Web Shell presentation and its measured document-export byte budget only. Do not change scheduling, cancellation, model input, transcript recording, replay metadata, or daemon APIs.
- Do not regroup ticks under a loop, invent a loop iteration number or chain ID, or create a session per tick.
- Do not add pending-wakeup badges, scheduled-task controls, or a new settings option.
- Do not change the meaning or editability of automatic user turns in this slice.
- Do not claim that `message.timestamp` is the scheduler's actual fire time: queued execution can make it later than `firedAt`, and that separate value is not available to this UI projection.
- Do not claim to expose full `modelText` for autonomous or `loop.md` ticks whose persisted `displayText` intentionally contains only a short echo. No model-input audit protocol is added in this slice.

## Proposed changes

### Message wiring

`MessageItem` passes the existing `message.source` to `UserMessage`. The adapter and message comparator already preserve and compare it, so no data-model change is needed. The existing outer `MessageTimestamp` remains the only timestamp display and keeps its current meaning.

### Automatic-trigger presentation

`UserMessage` selects the automatic-trigger presentation only when:

1. `source` is exactly `cron` or `loop`; and
2. the content does not match the existing structured per-run scheduled-task prompt.

The card uses the same automatic-trigger label for both sources. Persisted replay currently normalizes both to `cron`, so a source-specific Loop label would change appearance after reload.

The summary is the original display text with whitespace collapsed, truncated visually with CSS rather than by shortening stored or copied text. No schedule or task metadata is inferred from prompt text.

Interactive and readonly views default to the compact summary. The existing Show more/Collapse disclosure reveals the complete display text through the existing user-content rendering pipeline, including annotations, links, slash highlighting, attachment references, and host customization. Even a short ordinary prompt keeps this control so a narrow layout never removes access to its full text.

Only the runtime's complete short echo forms—`Autonomous loop tick`, `Loop tick — tasks from project loop.md`, `Loop tick — tasks from home loop.md`, and `Loop tick — loop.md temporarily unavailable`—render as static compact cards with no disclosure. Those labels intentionally contain no full `modelText`. A real prompt or unrecognized future source label that merely shares the `Loop tick — ` prefix keeps its disclosure in interactive views and its complete text in exported documents; the matcher fails open.

Document mode follows `TranscriptDocumentExpandedContext`, whose default is expanded, and exposes no interactive disclosure. Detailed content is included by default; a short echo needs no duplicate body.

Rich content is constructed lazily on the built-in renderer path. A closed interactive disclosure does not invoke the default parser. Expansion constructs it once, and default-expanded document output still constructs it. When a host supplies `renderUserMessageContent`, the automatic-card variant is bypassed so the host's previous complete-content replacement or redaction contract remains authoritative; the raw summary is never reintroduced around that output.

The existing bubble and selectors remain in place. A dedicated selector and `data-source` attribute identify the new presentation for browser tests. Images, files, retry affordances, and the inline editor stay in their current outer layout; editing continues to use the complete original text.

The generic 400 px overflow disclosure is disabled for automatic-trigger cards so users never need two successive expansions. Its behavior remains unchanged for ordinary and per-run messages.

### Styling and localization

Add scoped styles to `UserMessage.module.css`, reusing the existing scheduled-task visual tokens, icon treatment, metadata wrapping, and semantic colors. Add English `userMessage.automatic.title` in `i18n.tsx`, Simplified Chinese in `i18n-zh-cn.ts`, Traditional Chinese in `i18n-zh-tw.ts`, and Russian in `i18n-ru-part5.ts`, so every supported catalog displays a localized eyebrow.

## Key design decisions

| Decision                                                  | Rationale                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change the `UserMessage` variant, not the transcript role | User-role entries remain turn starts, while existing edit, delete, retry, timeline, and tool-call consumers continue to see the same message.                               |
| Integrate inside `UserMessage`                            | This preserves attachments, custom content rendering, editing, failure handling, and the per-run card without a parallel message path.                                      |
| Prefer the existing per-run card                          | Its structured task name, cron, task ID, trigger, and session mode are more informative than a generic automatic card.                                                      |
| Use one source-neutral visible label                      | Replay maps persisted automatic records to `cron`; the UI must not relabel the same tick after reload.                                                                      |
| Keep the existing outer timestamp only                    | The available value is a projection/execution timestamp, not necessarily the scheduler fire time, and a second card timestamp would duplicate and overstate it.             |
| Suppress redundant short-echo disclosure                  | The compact echo is already complete and the full model instruction is unavailable to this projection, so a full-instructions control would be both useless and misleading. |
| Construct detail content on demand                        | Long sessions should not parse or host-render every hidden instruction merely to show a compact summary.                                                                    |
| Do not group by wakeup ID                                 | Self-paced rearming creates a new one-shot ID, so it is not a stable loop-chain identity.                                                                                   |

## Files affected

- `packages/web-shell/client/components/MessageItem.tsx` — pass source.
- `packages/web-shell/client/components/messages/UserMessage.tsx` — select the compact variant and lazily construct details.
- `packages/web-shell/client/components/messages/UserMessage.module.css` — scoped card and disclosure styles.
- `packages/web-shell/client/i18n.tsx`, `i18n-zh-cn.ts`, `i18n-zh-tw.ts`, and `i18n-ru-part5.ts` — labels for every supported catalog.
- `packages/web-shell/client/i18n.test.ts` — localized catalog coverage.
- `packages/web-shell/client/components/MessageItem.dom.test.tsx` — prop forwarding and source-update coverage.
- `packages/web-shell/client/components/messages/UserMessage.test.tsx` — component behavior and regression coverage.
- `packages/web-templates/src/export-html/build.mjs` — measured renderer budget for the added presentation and existing static-export behavior.
- `packages/web-shell/client/e2e/web-shell.automatic-trigger-message.spec.ts` — deterministic browser coverage and screenshots.

## Validation plan

- Unit-test both `cron` and `loop`, ordinary/unknown sources, per-run priority, disclosure, short-echo suppression, lazy host rendering, attachments, editing, source-triggered reset, empty content, document expansion, and preservation of real `Loop tick — ` prefixed instructions in interactive and document views. Verify that the automatic-trigger title is localized for every supported catalog.
- Verify that changing only the source on an existing `MessageItem` updates the forwarded props, and that an ordinary expanded message becomes compact when its source becomes automatic.
- Run the focused Web Shell tests, package typecheck, lint and format checks, then the repository build and typecheck required by the contributor workflow. Rebuild `dist/transcript.js` and WebTemplates and verify the measured renderer is 2,151,654 bytes, below a 2,152,000-byte ceiling with a 346-byte local margin. Regression cases cover unrecognized `tasks from` source labels and exclusive host replacement/redaction rendering.
- Run a Playwright scenario with the same cron, loop, ordinary, and per-run fixtures against the baseline and changed build. Capture compact and expanded states at desktop and mobile widths and assert no horizontal document overflow.
- Keep model-facing JSONL content and replay source assertions as regression evidence; no production changes are expected in those layers.

## Acceptance criteria

- Automatic inputs occupy a compact card by default instead of showing their full prompt in an ordinary bubble.
- Where detailed display text exists, one user action reveals it with the existing rich rendering intact; short echoes do not get a redundant or misleading disclosure.
- Ordinary user messages and structured per-run scheduled-task messages retain their current presentation.
- Built-in closed disclosures defer the default rich-content parser, while host-provided replacement or redaction rendering retains its complete ownership of the message body.
- Attachments, editing, retry, source metadata, existing timestamp semantics, turn boundaries, and tool-call navigation continue to work.
- Static document output includes detailed display text by default and has no interactive control.
- Focused tests and browser checks pass at desktop and mobile widths without horizontal overflow.

## Open questions

None for this display-only slice. Stable loop grouping and faithful fire-time/model-input projections require separate data designs and are intentionally deferred.
