# Always-visible question answers

[English](2026-09-09-web-shell-question-message.md) | [简体中文](2026-09-09-web-shell-question-message.zh-CN.md)

## Problem and scope

Completed AskUserQuestion results currently join tool summaries and disappear
inside the completed turn's “Processed” fold. Keep these records visible like
user messages, with a right-aligned bubble containing each question above its
answer. Exclude AskUserQuestion from the Processed tool count. Preserve model-authored question text, including prefixes. Pending question controls keep their interaction; their toggle gains explicit Expand/Collapse text and a down/up action arrow. Nested subagent tools keep their behavior.

## Design

MessageList isolates completed question tools from mixed groups, excludes them
from compact merging, and keeps them outside completed-turn folding. Preserve
the tool_group role, chronological order, and tool call identity so answers do
not create new user turns. MessageItem renders a question-answer bubble using
UserMessage's existing layout classes without applying user-input parsers.

The producer returns a structured display result:
`{ type: 'ask_user_question_answers', text, answers: [{ question, answer }] }`.
The existing model-facing text stays unchanged. PostToolUse hooks receive the
original string in `tool_response.returnDisplay`; PostToolBatch hooks receive
the readable text in `tool_calls[].tool_response.result_display`. Shared hook
normalization copies each question response without mutating the structured
UI/history result. History and recording use the existing 32,000-character
compactor for each display text, question, and answer field, preserving the
question/answer structure and truncation markers. Short fields and the original
model-facing result remain unchanged.
CLI renderers display `text`;
Web Shell validates the discriminator and string fields, then renders the answer
array directly. Partial submissions include only the answers actually supplied.
There is no prefix matching, regex parsing, or timestamp-based migration.

Only structured results use the right-aligned question/answer bubble. Historical
string results, including single questions, remain in the left-side ToolGroup
with its existing expansion control. This change excludes both formats from the
Processed turn fold and tool count. Empty results render no bubble or timestamp.

ACP and persisted records already carry structured result displays. The SDK
projects the new result into a bounded, allowlisted `question_answers` preview;
document exports sanitize and preserve those fields. Web Shell reconstructs the
same display shape from safe previews, keeping live, replay, and exported views
consistent. Unknown or malformed results use the existing tool presentation.
Multiline answers and literal code remain unchanged within these preview limits.

Live tool preparation can create an empty argument placeholder before the
permission request supplies full questions. Associate permission question data
with tool calls after projecting all blocks, and fill missing question arguments
rather than treating an empty object as complete. This keeps immediate submission
consistent with history replay without changing stored messages.

## Files and validation

Update the core result type and producer, CLI text fallbacks, SDK previews,
export validation, and their focused tests.
Change MessageList, MessageItem, toolFormatting, and add the result component
with scoped styles. Update collocated transcript and grouping tests. Cover
compact and normal views, mixed tool groups, completed-turn folding, multiple
questions, multiline answers, and historical replay. Run browser validation,
focused unit tests, build, typecheck, bundle, and full-diff self-review.

## Acceptance criteria and risks

New structured question answers remain visible before and after expanding or
collapsing Processed, in the original answer order. Questions precede their
answers with no inner fold. Legacy records remain on the left. Live completion
and reload use the same question/answer layout; oversized saved previews retain
explicit truncation markers. Long text wraps inside the bubble. Marker-shaped answer lines
cannot create extra answers because display boundaries come from the array.
Unknown fields must not survive safe projection or export. No historical data
is rewritten; the result discriminator determines presentation.

## Open questions

None.
