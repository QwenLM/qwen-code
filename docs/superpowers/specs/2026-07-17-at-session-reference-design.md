# `@` Session Reference + Tabbed Completion UI — Design

Date: 2026-07-17
Branch: `lazzy/at-session-ref`
Status: Proposed

## 1. Goal

Two related enhancements to the interactive `@` mention feature:

1. **Reference prior sessions via `@`.** Let a user pull a _condensed_ copy of an
   earlier chat session's history into the current context as reference material —
   without having to `fork` the session. The reference is injected as read-only
   context, not as a resumed/forked timeline.
2. **Tabbed `@` completion UI.** Because `@` now surfaces more categories
   (files, directories, sessions, MCP servers/resources, extensions), redesign
   the suggestion dropdown into a **tab-switched** layout so it stays usable.

## 2. Decisions (locked)

| Dimension                    | Decision                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| How the session is condensed | **Mechanical slimming, NO LLM call** — deterministic                                                                        |
| What slimming keeps          | **user + assistant text + a one-line summary per tool call** (name + status; no bulky tool results)                         |
| Referenceable scope          | **Current project only** (project-hash scoped, same as `resume`)                                                            |
| How `@` surfaces sessions    | **Bare `@` shows a Sessions group** (no prefix required to discover); a `@session:` prefix also works for direct addressing |
| Completion UI shape          | **Tab switch** — top tab bar (All / Files / Sessions / MCP / Extensions), single list below shows the active tab            |
| Injected size cap            | **Fixed token budget with tail-retention** — drop oldest turns first, mark as truncated                                     |

Explicitly rejected: LLM summarization (conflicts with the "inject slimmed
original, no model call" decision), reusing `ChatCompressionService` (it calls
the model and is coupled to a live `GeminiChat`), cross-project referencing.

## 3. Architecture (Approach 1 — core service + localized UI changes)

Split into two independent halves: **backend** (parse + load + slim + inject)
lives in core and is a pure, unit-testable function; **frontend** (tabbed
dropdown) is a localized render-layer + keybinding change.

```
packages/core/src/services/
  sessionReferenceService.ts   [NEW]  load → slim → budget-trim → injectable text

packages/cli/src/ui/hooks/
  sessionMentionRef.ts         [NEW]  parse/build/validate @session:<id|title>
  atCommandProcessor.ts        [EDIT] new @session: routing branch → service → Part
  useAtCompletion.ts           [EDIT] new session-suggestion producer (category tag)
  useCompletion.ts             [EDIT] track activeCategory; reset index on tab switch

packages/cli/src/ui/components/
  SuggestionsDisplay.tsx       [EDIT] tab bar + filter rows by active category
  InputPrompt.tsx              [EDIT] new keybinding to switch tab (←/→)
```

### Module responsibilities

| Unit                        | Responsibility                                 | In → Out                                        | Reuses                                                                  |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `SessionReferenceService`   | Turn a session id into injectable slimmed text | `sessionId` → `{ text, meta, truncated }`       | `SessionService.loadSession`, `filterToDialog`, `estimateContentTokens` |
| `sessionMentionRef.ts`      | Parse/build/validate `@session:` refs          | string ↔ `{ id?, title? }`                     | —                                                                       |
| `atCommandProcessor` (edit) | Route `@session:` → service → injected part    | ref token → `Part`                              | `SessionReferenceService`                                               |
| session producer (edit)     | List referenceable sessions as suggestions     | pattern → `Suggestion[]` (`category:'session'`) | `SessionService.listSessions`                                           |
| `SuggestionsDisplay` (edit) | Render category tabs; show active tab's rows   | `Suggestion[]` + `activeCategory` → TUI         | —                                                                       |

## 4. Backend: session → injectable text

1. **Resolve ref.** `@session:<arg>` where `<arg>` is a session UUID or a
   (custom) title. UUID → direct; title → `SessionService.findSessionsByTitle`
   (active, current-project only). Ambiguous title (>1 match) → the completion
   UI already disambiguates; at submit time a still-ambiguous title is reported
   as an unresolved mention (left as literal text, with a note), not guessed.
2. **Load.** `SessionService.loadSession(id)` → `ConversationRecord.messages`
   (`ChatRecord[]`). Guard: `sessionBelongsToCurrentProject` (already enforced
   inside `loadSession`) — cross-project ids resolve to "not found".
3. **Slim (deterministic, no model call).**
   - Reuse `filterToDialog` to keep user + assistant visible text, dropping
     thoughts.
   - For records that are tool calls (`message.parts` functionCall /
     `toolCallResult`), emit a single line: `[tool: <displayName> — <status>]`.
     Do **not** include tool result bodies.
   - Preserve chronological order; render as a labeled block:
     `--- Referenced session "<title>" (slimmed, read-only) ---\n<body>`.
4. **Budget-trim.** Estimate with `estimateContentTokens`. Cap at a fixed budget
   (default `SESSION_REF_TOKEN_BUDGET`, ~8k, configurable). If over budget,
   **drop oldest turns first** (tail-retention) and prepend a
   `[earlier turns omitted]` marker so the model knows it is truncated.
   Return `truncated: true` in meta.
5. **Fast path.** If the loaded records contain a `chat_compression` record with
   `systemPayload.compressedHistory`, that snapshot MAY be used as the slimmed
   body directly (already condensed) — optional optimization, not required for v1.

Output shape:

```ts
interface SlimmedSessionReference {
  text: string; // labeled, budget-trimmed block
  meta: {
    sessionId: string;
    title: string;
    messageCount: number;
    approxTokens: number;
  };
  truncated: boolean;
}
```

### Injection (atCommandProcessor)

New routing branch, ordered **after** extension/MCP refs and **before** the
filesystem path fall-through (so `session:` with its `:` is never mistaken for a
path). Resolved session text is added to `scopedMentionParts` (same bucket as
MCP-server context), so final assembly stays grouped-by-type. The `@session:…`
token is left verbatim in the prompt text; the model correlates it with the
`--- Referenced session … ---` block. A tool-call display card
("Referenced session") is emitted, mirroring the existing Read File / Activate
Extension cards. Unresolved / not-found / cross-project refs fall back to literal
text with a surfaced note (never silently dropped).

## 5. Frontend: tabbed completion UI

- **Suggestion type.** Add `category?: SuggestionCategory` to `Suggestion`
  (`'file' | 'session' | 'mcp' | 'extension'`). Existing `sourceBadge` stays for
  inline labels; `category` drives tab grouping. Files with no tag default to
  `'file'`.
- **Producer.** In `useAtCompletion.ts` add a session producer that calls
  `SessionService.listSessions` (current project), maps each to a `Suggestion`
  with `category:'session'`, `label` = title (fallback: first user prompt,
  truncated), `value` = `@session:<id>`, `description` = relative time / message
  count. Shown on **bare `@`** (like extensions) and filtered by pattern.
- **Rendering.** `SuggestionsDisplay.tsx` gains an optional top tab bar modeled on
  `StatsDialog`'s `StatsTabs` / `handleTabChange` / `useKeypress` trio: tabs are
  `All` + each non-empty category. `All` shows every suggestion (current
  behavior); a specific tab filters to that category. Tab counts shown per tab.
  When only one category is present, the tab bar is hidden (no regression for
  plain file completion).
- **Keyboard.** `↑/↓` selects within the active tab (unchanged). Tab **switching**
  uses `←/→` (and/or `Shift+Tab`) via a **new keybinding Command**, because
  `Command.ACCEPT_SUGGESTION` already binds BOTH `Tab` and `Enter` in
  `InputPrompt.tsx` — reusing `Tab` would collide. `useCompletion` tracks
  `activeCategory` and resets `activeSuggestionIndex` / scroll on switch.
- **State ownership.** `activeCategory` lives in `useCompletion` (alongside
  `activeSuggestionIndex`), so accept/scroll logic stays in one place.

## 6. Error handling

| Case                                   | Behavior                                                          |
| -------------------------------------- | ----------------------------------------------------------------- |
| Session id not found / cross-project   | Ref left as literal text + surfaced note; no throw                |
| Title matches >1 session at submit     | Reported as ambiguous unresolved mention (literal text + note)    |
| Loaded history empty after slimming    | Inject a short `(no textual content)` note instead of empty block |
| Over token budget                      | Tail-retain, prepend `[earlier turns omitted]`, `truncated:true`  |
| `listSessions` fails (I/O) in producer | Session tab shows empty/"unavailable"; other tabs unaffected      |
| Only one category available            | Tab bar hidden; behaves exactly as today                          |

## 7. Testing

**Core (unit, no model):**

- `sessionReferenceService`: slimming keeps user+assistant text; tool records
  collapse to one-line summaries; tool result bodies excluded; chronological
  order; budget trim drops oldest first + sets `truncated`; empty-history note;
  cross-project id → not found.
- `sessionMentionRef`: parse/build/validate round-trip; UUID vs title; malformed.

**CLI (component / hook):**

- `atCommandProcessor`: `@session:<id>` routes to service and injects into
  `scopedMentionParts`; ordering vs MCP/ext/file; unresolved → literal fallback;
  display card emitted.
- `useAtCompletion`: session producer appears on bare `@`; filters by pattern;
  current-project scoping.
- `SuggestionsDisplay`: tab bar renders per non-empty category; `All` shows all;
  filtering by active category; single-category hides tab bar.
- `InputPrompt` / keybinding: `←/→` switches tab without triggering accept;
  `Tab`/`Enter` still accept; index resets on switch.

**Manual / e2e:** type `@`, switch to Sessions tab, pick a prior session, submit,
confirm the slimmed block reaches the model as a labeled context part and a
"Referenced session" card is shown.

## 8. Out of scope (v1)

- LLM-generated summaries of referenced sessions.
- Cross-project / cross-workspace session referencing.
- Referencing archived sessions by `@` (title search is active-only, matching
  existing `findSessionsByTitle`).
- Left/right split-column dropdown layout (chose tab switch instead).
- Referencing a _range_ / specific messages within a session (whole-session only).
