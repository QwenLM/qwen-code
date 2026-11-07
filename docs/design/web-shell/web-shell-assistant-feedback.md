# Web Shell Assistant Answer Feedback

[English](web-shell-assistant-feedback.md) | [简体中文](web-shell-assistant-feedback.zh-CN.md)

Status: implemented in this change.

## Problem

A reader of a completed answer has no way to tell Web Shell that the answer was
satisfactory or not. The CLI TUI already offers a feedback dialog, but it is
asked about the session rather than the turn, and no other client can record
per-turn sentiment about a specific answer.

Hosts embedding Web Shell also have nowhere to hook such a signal: the existing
answer-footer extension point only renders host content into its own block above
the action row, so a host cannot put controls next to the built-in Copy button.

## Goals

- Let the reader mark a completed assistant turn as satisfied or not satisfied,
  from the answer's own action row, directly right of Copy.
- Keep the mark visible afterwards, so a reader can see what they chose.
- Let a host learn about each mark, without letting the host become the source of
  truth for the UI state.
- Leave every other client and the daemon wire untouched.

## Non-goals

- No server-side persistence. The mark is not written to the session record, and
  is not readable by another browser, device, or client.
- No telemetry. Marking does not emit an `UserFeedbackEvent` or any other
  analytics event, and is not gated by the usage-statistics setting.
- No prompt-id anchoring, no daemon route, and no change to the daemon's
  transcript projection or wire format.
- No host-supplied initial state: a host cannot seed or override a mark.
- No per-turn visibility control: the host switches the whole feature on or off.

## Design

### Placement

The marks render in the completed assistant turn's action row, immediately after
the Copy button and before the Branch button, the turn sources, and the
timestamp. They appear only where Copy already appears — a completed, non
streaming answer that is the final answer of its turn, in an interactive
transcript.

### Interaction

| Current mark  | Click         | Result                                    | Host payload `rating` |
| ------------- | ------------- | ----------------------------------------- | --------------------- |
| none          | Satisfied     | Satisfied is lit                          | `up`                  |
| Satisfied     | Not satisfied | Satisfied goes dark, Not satisfied lights | `down`                |
| Not satisfied | Not satisfied | dark again, unmarked                      | `null`                |

The two marks are mutually exclusive. Every transition notifies the host once,
including the transition to unmarked. The host is a listener: the mark lands
before the notification runs, and nothing the host does in the callback — throw,
reject, open a dialog the reader never submits — changes the mark.

A marked turn is coloured by direction — blue for satisfied, red for not
satisfied — on a glyph sized to sit evenly beside the built-in Copy and Branch
icons. The colour survives hover and focus, because the row only appears on
hover; a mark that greyed out under the pointer would never be readable.

The row keeps its existing hover behaviour: marking does not pin it open. That
needs one explicit step, since a pointer click leaves the button focused and the
row's `:focus-within` rule would otherwise hold it open after the pointer
leaves. Pointer clicks release focus; keyboard activation keeps it, so the row
stays reachable without a mouse.

### State and storage

Web Shell owns the mark. State lives in the message list rather than in a message
row, because the transcript virtualizes and unmounts rows that scroll out of
view.

- Storage key: `qwen-web-shell-assistant-feedback`, one versioned JSON payload
  `{ v: 1, <sessionId>: { <promptId>: 'up' | 'down' } }`.
- The mark is keyed by the turn's admitted prompt id, not by a transcript block
  id. See "Turn identity" below for why that is the only value that survives a
  reload, and what happens when a turn has none.
- At most `MAX_ASSISTANT_FEEDBACK_SESSIONS` (10) sessions are kept. The oldest is
  dropped first, and editing a session moves it to the newest position so a
  session in active use is not aged out by an untouched neighbour.
- Clearing the last mark of a session removes that session's entry.

Storage is best effort. A private or embedded context can refuse `localStorage`
entirely, and a hand-edited or future payload may not parse: writing never
throws, and reading degrades to "nothing marked" rather than guessing. In all
failure modes the click still lands and the host is still notified; only the
memory across a reload is lost.

### Turn identity

A block id is not an identity: the transcript reducer mints ids as
`<kind>-<ordinal>` from a counter that starts at 1 per projection, so a block
id depends on how the transcript was loaded rather than on what it contains.
The mark is therefore keyed by the daemon's `promptId` — the uuid the daemon
mints at prompt admission — which the daemon also persists on the turn's
`turn_result` record and addresses turns by (`GET /session/:id/turns/:promptId`).

Where that value sits on the blocks differs between the two ways a transcript
arrives, which was measured end to end rather than assumed:

- **Live**: the assistant blocks carry it, and it equals the id returned when the
  prompt was admitted.
- **Replay** (opening a session, reloading, paginating — the daemon's
  `historyPageSize` path): the assistant blocks carry **no** `promptId`; only
  `user_message_chunk` does, and it equals the turn's persisted record.
- A reload served from the daemon's in-memory snapshot instead of a persisted
  replay carries it on the assistant blocks again, so which shape arrives is not
  fixed.

The client therefore takes `answer.promptId ?? headUserMessage.promptId`: both
sources hold the same value when either is present, and a turn with neither is
not offered the marks at all. A second consequence is that the mark is not
carried across a fork: forks deliberately exclude `turn_result` records so a new
session does not inherit the source's prompt identities.

### Host API

```ts
customization.assistantFeedback?: {
  enabled?: boolean;             // `false` hides the marks again
  onRate?: (info: {
    rating: 'up' | 'down' | null;         // null when a mark was cleared
    previousRating?: 'up' | 'down';
    sessionId?: string;                   // which conversation
    promptId: string;                     // which turn inside it
    userMessage: {
      text: string;                       // prompt tail, or what it carried
      timestamp?: number;                 // prompt wall-clock ms
    };
  }) => void;
};
```

`sessionId` locates the conversation and `promptId` locates the turn inside it —
the same pair the daemon's own turn routes take; neither alone is enough.

`userMessage.text` is the prompt's most recent 100 characters, trimmed, because
the tail is what distinguishes one prompt from another in a list of marks. When
the prompt carried no text at all, the text is instead what it carried: `[图片]`
when it had images, `[附件]` when it had attachments, and both joined by a space
when it had each. The placeholders are literal and do not follow the UI
language, because a host consumes them as data. A shell turn's prompt is its
command, so `text` carries the command for those turns.

A host passes this as the `assistantFeedback` prop on the embedded `WebShell`,
which forwards it into the customization context. Passing the object shows the
marks; omitting it leaves the answer footer exactly as it is today, which is what
keeps existing hosts unchanged. The payload types are exported from the package
entry so a host can name them. This repository's own standalone app does not opt
in, so the marks appear only where a host passes the option — deliberately, since
the standalone app has no host to notify.

The marks are offered only in an interactive transcript that has a session id, so
the read-only and embedded transcript renderings never show them — as does the
frozen historical viewport, which drops its session id and therefore hides the
marks on answers that still show Copy.

## Decisions and rationale

- **Built into the answer footer rather than a host-rendered footer.** The
  existing `renderAssistantTurnFooter` extension point renders above the action
  row, in its own block; it cannot place controls beside Copy, and it would force
  every host to re-implement lighting, exclusivity, and hover behaviour. The
  built-in path keeps one implementation and lets a host opt in with one object.
- **The host is notified, never consulted.** A host that could reject or revert a
  mark would make the icon's state depend on a network round trip, and would put
  the record of what the reader chose outside the client. Notification-only keeps
  a click instant and its outcome final.
- **Local storage rather than a session record.** Per-turn feedback persisted
  server-side would need a daemon write route, a new record type in a session
  file every client reads, and a read-back projection — a scope far beyond the
  feature, and one that reopens questions about user data and telemetry gating.
  A deliberately local mark buys the visible behaviour now and leaves the
  upgrade path open.
- **No reuse of the TUI's `UserFeedbackEvent`.** That event is session-scoped,
  three-valued (`bad`/`fine`/`good`), has no "cleared" state, and its writer also
  emits telemetry. Reusing it would bind a UI toggle to an analytics sink and
  still not express a per-turn mark.

## Constraints

- The mark is keyed by session and turn, so it requires both. A transcript
  without a session id is not offered the marks rather than accepting clicks that
  could not be stored.
- Two tabs, or two panes, do not synchronize live, and a write replaces the whole
  stored payload: each renders from the storage it read when it mounted, and a
  mark made in one instance can be dropped by a write from another.
- A session that is deleted, rewound, or forked leaves its marks behind until the
  ten-session cap ages them out. They are never shown for a different session.

## Risks

- If a host also persists the marks on its own side, the two records can
  disagree — for example after the host deletes or migrates its copy. The client
  mark is presentation state and never reads the host's.
- A cleared mark deletes the stored entry, so nothing preserves the history of
  a reader changing their mind.

## Files

| File                                                                        | Change                                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/web-shell/client/adapters/messageTypes.ts`                        | Declares `promptId` on rendered messages.                                                                                          |
| `packages/web-shell/client/adapters/transcriptToMessages.ts`                | Pass that copies the id from the contributing blocks onto the messages built from them.                                            |
| `packages/web-shell/client/utils/assistantFeedback.ts`                      | Store shape, pruning, tolerant read, best-effort write, the offer predicate, the prompt summary, and the host notification helper. |
| `packages/web-shell/client/hooks/useAssistantFeedback.ts`                   | Owns the marks for one session and persists them.                                                                                  |
| `packages/web-shell/client/components/messages/AssistantMessage.tsx`        | Renders the two marks in the answer action row.                                                                                    |
| `packages/web-shell/client/components/messages/AssistantMessage.module.css` | Direction colour for the marked icon, and the glyph sizing that matches its neighbours.                                            |
| `packages/web-shell/client/components/MessageItem.tsx`                      | Binds a row to its turn and prompt id.                                                                                             |
| `packages/web-shell/client/components/MessageList.tsx`                      | Hosts the state, resolves each turn's prompt id, and builds the host payload.                                                      |
| `packages/web-shell/client/customization.tsx`                               | `assistantFeedback` option and its payload types.                                                                                  |
| `packages/web-shell/client/i18n.tsx`                                        | `assistant.satisfied` and `assistant.dissatisfied`.                                                                                |
| `packages/web-shell/client/index.tsx`                                       | Exports the payload types from the package entry.                                                                                  |
| `packages/web-shell/client/App.tsx`                                         | Forwards the host's option into the customization context.                                                                         |

## Verification

Unit tests:

- `utils/assistantFeedback.test.ts`: round-trip, tolerant read (non-JSON, unknown
  rating, wrong version, throwing `localStorage` with a positive control), write
  that never throws, pruning and re-ordering, mark/switch/clear, the offer
  predicate's five cases, the prompt summary (tail length, trimming, the
  attachment and image placeholders, an unknown prompt), and the notification
  helper's throw containment.
- `adapters/transcriptToMessages.test.ts`: the prompt-id pass stamps the messages
  built from stamped blocks, and invents no id for a block that has none.
- `hooks/useAssistantFeedback.test.tsx`: marks immediately without a host
  handler, notifies with `previousRating`, clears on a repeat click, restores the
  mark after a remount, and keeps marks per session.
- `components/messages/AssistantMessage.test.tsx`: no marks unless opted in,
  `aria-pressed` projection, the per-direction colour class, pointer-versus-
  keyboard focus handling, click-to-notify payloads, and the localized titles.

The live-versus-replay behaviour of `promptId` in "Turn identity" was measured
end to end against a real daemon and a real browser, not inferred from the
reducer: the same turn's assistant block carries the admitted id while streaming
and no id after a persisted replay, while the prompt's own block carries the
persisted value in both cases. That measurement is why the key falls back to the
prompt's block instead of the answer's.

Gates: `prettier`, `eslint --max-warnings 0`, `tsc --noEmit`, and the full
`packages/web-shell` suite all pass.

Manual: the visual result is checked by the owner on the running dev page. The
strings introduced are `Satisfied` / `Not satisfied` in English and `满意` /
`不满意` in Chinese, used as both tooltip and accessible name.

## Acceptance criteria

- With the option passed and a session id present, the marks appear on the final,
  completed, non-streaming answer of an interactive turn and on no other row.
- Clicking a mark lights it and notifies the host once, reporting `previousRating`
  as it was before the click; clicking the lit mark clears it and notifies with
  `rating: null`.
- A mark survives a reload of the same session and is never shown for a different
  session.
- Omitting the option, or rendering a read-only or document transcript, shows no
  marks and changes nothing else in the footer.

## Follow-up work

- Server-side persistence is still not implemented: the mark lives in this
  browser. Doing it later means writing a record through a new daemon route and
  reading it back through a projection — the key (`sessionId` + `promptId`) and
  the payload in this document already carry what such a record needs.
- The TUI's feedback dialog numbers its options `GOOD: 1, BAD: 2, FINE: 3` while
  the telemetry enum is `BAD = 1, FINE = 2, GOOD = 3`, and the rating is cast
  across without remapping, so the recorded rating is rotated. That is a
  pre-existing defect on a telemetry path, independent of this feature, and is
  deliberately not changed here.
