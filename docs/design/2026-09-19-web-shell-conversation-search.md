# Search within a Web Shell conversation

[English](2026-09-19-web-shell-conversation-search.md) | [简体中文](2026-09-19-web-shell-conversation-search.zh-CN.md)

## Problem and scope

Issue #12231 requests a search dialog beside the scroll-to-bottom button, with direct navigation to matching content. The sidebar search from #10261 / #10612 finds sessions and returns one snippet per session; it cannot locate individual messages. #6824 and #11111 concern other session-search surfaces. This change searches user and assistant text, including Markdown and code, in the active Web Shell conversation. It does not change cross-session search, tools, thinking, or model requests.

## Design

Expose `conversationSearchThreshold` on `WebShellProps`, defaulting to 10. The search icon appears when the user/assistant message count strictly exceeds this threshold, independently of whether the scroll-to-bottom button is visible. Position a compact 14px search icon below the left session timeline, with a 20px-wide button that fits the navigation gutter. The search entry is hidden whenever the timeline ticks are hidden. Embedding entry points inherit the option.

Reuse `DialogShell`, localized labels, semantic colors, and the portal root. Focus the input on opening. Debounce text queries, show highlighted snippets, support result selection and previous/next result controls, and close with Escape. Keep the composer draft and running response untouched.

Use the session-owned turn-navigation client to scan persisted transcript pages into isolated per-page projections. Retain at most 200 result snippets rather than loading the whole transcript into the live store. Display the available result count and whether results were capped. An empty query with `stopAfterMessages` probes the visibility threshold without scanning the entire history. Matching is literal and case-insensitive, including Chinese text.

Results carry persisted record identity and the containing turn ordinal from the turn index. Render-time message IDs are not stable across projections. Navigation reuses the existing historical viewport: locate the turn, page forward if needed, map the persisted record to the current block/message, expand folded content, center it, and flash the target. Historical pages remain subject to the existing LRU budget. Live messages are searched from the current transcript snapshot and merged with persisted hits by source identity.

## Lifecycle and limitations

Closing the dialog, changing the query, or switching sessions invalidates outstanding searches. Navigation rejects stale session/revision results and verifies the persisted turn identity. Partial replay and request failures must remain visible with retry; they must not be reported as a completed search with no matches. Older daemons without turn navigation can search loaded messages, with an explicit limited-history notice. No additional daemon API, full-text index, or settings persistence is introduced.

## Files and validation

The implementation belongs to the Web Shell entry props, search component, i18n, turn-navigation store, historical viewport hook/handle, README, and collocated tests. Use synthetic transcripts only.

Verify the 10/11 boundary and custom thresholds; old messages outside the live window; user/assistant/code and Chinese/English text; repeated matching messages; empty/no-match queries; stale requests and session changes; collapsed and virtualized targets; draft preservation; and streaming continuity. Check light/dark, Chinese/English, desktop/mobile, and portal behavior. Record baseline and local-build E2E evidence separately from unit/build/typecheck results.

## Open questions

None. The threshold is a host component option; a settings-page control and cross-session search are outside this issue.
